# Artifacts: git semantics, forks, push events, writing from a Worker

Observed 2026-10-02 on a live account.

Everything below was run against a real Artifacts namespace (jurisdiction `eu`) with git 2.55.0, `wrangler@4.147.0` and `isomorphic-git@1.42.6`. The code and the exact steps are in `spikes/artifacts-git/`. REST calls were made through the Cloudflare MCP server's authenticated client, not curl. Account identifiers are replaced with `<account-id>`; token secrets are replaced with `<secret>`.

Verdicts: `works`, `fails`, `partial`, `not tested`.

## What this changes

1. **A Worker can write to an existing repository and merge a fork without a container, and the cheap way does not clone.** Committing one file through binding reads plus a hand-built pack cost 17–47 ms CPU over four runs, the same on a 37 MiB repository as on a tiny one; a fast-forward merge done by relaying the fork's pack to the parent cost 5 ms and 15 ms CPU in its two successful runs. For decision files and for small fast-forward merges the container fallback was not needed. A true merge with isomorphic-git on the 37 MiB repository worked once, at 8.9 s CPU with 75 MB held in the in-memory filesystem; the same clone-and-fetch with a checkout held 124 MB. No limit was hit, so where it stops fitting is not measured — but memory held is about twice the pack size, which argues for keeping the container (or a tree merge built on binding reads) for true merges of larger repositories.
2. **`read_only` does not stop a push, and the server did not refuse any history rewrite a write token asked for.** A repository created with `read_only: true` accepted two pushes. Non-fast-forward updates, force pushes and deletions of non-default refs were all accepted; the one refusal seen was a stale old value (`ng … stale ref`). Deleting the default branch was not tried. The only protection for the main repository is that nobody but gitflare holds a write token for it — the per-session-fork design stands, and `read_only` cannot be part of it.
3. **A fork copies every ref, and `default_branch_only` / `defaultBranchOnly` changes nothing.** Forks made with the flag unset, `true` and `false`, over REST and through the binding, all contained every branch, tag, note and `refs/entire/*` ref of the parent. A per-session fork carries the full history and is reported as its own repository at nearly the parent's size (41 MB next to 42.7 MB in the storage analytics; whether the bytes are physically shared or billed twice was not observed); fork time grows with size (2 s for a tiny repository, 6.6 s for 37 MiB). A fork of a sibling transcript repository would carry every checkpoint.
4. **Push events are a "this ref moved" signal and nothing more.** One event per ref, delivered out of order, with no actor or token id. The `commits` array is a first-parent walk capped at 20: a new branch lists the whole history, a merge lists only the merge commit, non-branch refs list nothing, and `totalCommitsCount` stops at 21. Take `ref`, `before`, `after` and the repository name from the event; read everything else from the repository, and treat the event as a prompt to re-read the ref.
5. **Non-branch refs work end to end.** `refs/entire/checkpoints/*`, `refs/notes/*`, tags and arbitrary namespaces are accepted, listed, fetchable by refspec, and produce push events. The `git-branch` fallback for the capture client is not needed. The binding cannot resolve such a ref by name, but reads it by the commit SHA the event carries.
6. **Blobless partial clone works** (`--filter=blob:none`, protocol v2 only). The shallow-fetch-only plan can be relaxed; `--filter=tree:0` fails.
7. **A namespace-only `triggers.events` filter covers forks created after deploy.** The Wrangler shape in `artifacts.md` is right; the shape in Cloudflare's guide is rejected.
8. **The binding's `log()` takes a short branch or tag name or a full SHA — not `refs/heads/main`, not `HEAD`.** `info()` reports no size, and `lastPushAt` stayed `null` after dozens of pushes.
9. **Token details differ from the docs.** Every token minted in this one `eu` namespace was `art_v2_e_…`, not `art_v1_…` (other namespaces were not tried); the `?expires=` suffix is ignored by the server, which enforces expiry from its own record. No atomic push and no push options, so a push cannot carry an actor.

## 1. Plain git against Artifacts

Run: `spikes/artifacts-git/git-tests.sh <env> auth clones tokens` and the REST calls in the README, step 1.

**Namespace with a jurisdiction — works.**

```txt
POST /accounts/<account-id>/artifacts/namespaces  {"namespace":"gitflare-spike-a-eu","jurisdiction":"eu"}
201 {"namespace":"gitflare-spike-a-eu","jurisdiction":"eu","repo_count":0,"created_at":"2026-10-02T16:34:32.873Z",…}
```

Repository create returns `remote` and an initial `token`; that token is a write token with a 24 h TTL and appears in the token list. `ttl: 30` is refused with `10103: ttl must be between 60 and 31536000 seconds`.

**Token format.** `art_v2_e_<40 hex>?expires=<unix seconds>` in this `eu` namespace — not the documented `art_v1_`. Do not parse the prefix.

**Presenting the token.**

| Form | Verdict | Came back |
| --- | --- | --- |
| `Authorization: Bearer <full token with ?expires=>` | works | refs listed; push accepted |
| `Authorization: Bearer <secret only>` | works | refs listed |
| Bearer, secret with `?expires=` rewritten to 2020 | works | refs listed — the suffix is not checked |
| Basic in the URL, `https://x:<secret>@…` | works | refs listed |
| Basic in the URL, `x:<full token, percent-encoded>` | works | refs listed |
| Basic, secret as the username, `x` as password | fails | `remote: Authentication required` |
| No credentials | fails | `HTTP/2 401`, `www-authenticate: Basic realm="artifacts"` |

The `401` advertises Basic, so git asks its credential helper: a helper that returns any username and the token as password works. With credentials in the URL, git also offers them to the configured helper for storage (macOS keychain here), which is a reason to prefer the helper or the header over URL-embedded tokens.

**Clones.**

| Command | Verdict | Came back |
| --- | --- | --- |
| `clone --depth 1` | works | one commit, `is-shallow-repository` true |
| `fetch --depth=1 <remote> <sha>` into an empty repository | works | `* branch <sha> -> FETCH_HEAD` |
| `clone --filter=blob:none --no-checkout` (protocol v2, git's default) | works | 3 objects missing before checkout, 0 after: blobs are fetched on demand |
| the same with `-c protocol.version=1` | fails | `warning: filtering not recognized by server, ignoring`; a full clone |
| `clone --filter=tree:0` | fails | `error: RPC failed; HTTP 400`, `fatal: expected 'packfile'` |

Capability advertisements, verbatim:

```txt
upload-pack v1:  agent=gitty/1.0 object-format=sha1 multi_ack multi_ack_detailed no-done side-band side-band-64k shallow
                 deepen-since deepen-not deepen-relative allow-tip-sha1-in-want allow-reachable-sha1-in-want no-progress
                 symref=HEAD:refs/heads/main
upload-pack v2:  agent=gitty/1.0 | ls-refs=unborn | fetch=shallow filter sideband-all | object-format=sha1
receive-pack:    report-status delete-refs ofs-delta side-band-64k symref=HEAD:refs/heads/main
```

The docs' contradiction resolves this way: `filter` is absent from v1 and present in v2. On the 37 MiB repository a blobless clone took 0.8 s and 344 kB; a `--depth 1` clone took 3.6 s and 37 MB.

**Token failure modes.**

| Case | Verdict | Came back |
| --- | --- | --- |
| Push with a read token | refused | `remote: Insufficient permissions`, HTTP 403 |
| Revoked token, fetch and push (8 s after `DELETE …/tokens/:id`) | refused | `remote: Invalid or expired token`, HTTP 403 |
| 60 s token, before expiry | works | refs listed, push accepted |
| 60 s token, 4 s after expiry | refused | `remote: Invalid or expired token`, HTTP 403 |
| Expired token with `?expires=` rewritten to tomorrow, or secret only over Basic | refused | same 403 — expiry is enforced server-side |
| Token for repository A used on repository B (also parent ↔ fork) | refused | `remote: Invalid or expired token`, HTTP 403 |
| Token of a deleted repository | refused | same 403 |
| **Push with a write token to a `read_only: true` repository** | **accepted** | `* [new branch] main -> main`, and a second push `89c0e61..7cb8ee3 main -> main`; `GET` on the repository still says `"read_only": true` |

`read_only` — fails as a write barrier. Reproduced on two repositories. A wrong-scope token and an unknown token give different messages (`Insufficient permissions` against `Invalid or expired token`), both 403; a credential helper should refresh on either.

**What the server does not check — hand-built `git-receive-pack` requests** (`git-tests.sh … raw`):

```txt
old value stale:                              000eunpack ok / 0021ng refs/heads/main stale ref    (HTTP 200)
old value right, new commit not a descendant: 000eunpack ok / 0017ok refs/heads/main              (HTTP 200)
```

The old value is compared and swapped (so two writers cannot silently overwrite each other), but a non-fast-forward is accepted without any force flag. `git push --atomic` is refused (`the receiving end does not support --atomic push`) and so is `git push -o …` (`the receiving end does not support push options`).

What it means: mint and revoke are the whole access model, as the concept already assumed. Gitflare must never hand out a write token for the main repository, and must do its own non-fast-forward check before it pushes a merge. A push cannot be annotated with an actor.

## 2. Non-branch refs

Run: `git-tests.sh <env> refs`.

| Ref | Push | `ls-remote` | Fetch by explicit refspec |
| --- | --- | --- | --- |
| `refs/entire/checkpoints/JV/01M3WE2VX9HQC3NVY9BWYCW6JV` (an orphan commit) | works | works | works |
| `refs/notes/commits` | works | works | works |
| `refs/tags/v0.1`, annotated `refs/tags/v0.2` | works | works (peeled `^{}` shown) | works (tags also arrive with a plain clone) |
| `refs/gitflare/changes/1/head`, `refs/pull/1/head` | works | works | works |

```txt
$ git push <remote> refs/entire/checkpoints/JV/…:refs/entire/checkpoints/JV/…
 * [new reference]   refs/entire/checkpoints/JV/01M3WE2VX9HQC3NVY9BWYCW6JV -> refs/entire/checkpoints/JV/01M3WE2VX9HQC3NVY9BWYCW6JV
$ git ls-remote <remote> 'refs/entire/*'
232aef72…  refs/entire/checkpoints/JV/01M3WE2VX9HQC3NVY9BWYCW6JV
$ git fetch <remote> '+refs/entire/*:refs/entire/*' ; git show refs/entire/checkpoints/JV/…:metadata.json
{"session":"x"}
```

Also works: a wildcard refspec, `fetch --depth=1 <remote> <that ref>` into an empty repository, fetching the checkpoint commit by bare SHA, protocol v1, and deleting such a ref. A plain clone brings branches and tags only, as with any git server. Each such push produces a push event (section 4).

Verdict: **works**. The capture client's `git-refs` backend can target Artifacts as is; the `git-branch` fallback in `entire-capture.md` is not needed. One limit on the reading side: the binding does not resolve these refs by name (section 6).

## 3. Forks

Run: `git-tests.sh <env> forks`, the REST fork calls in the README, and `POST /binding/fork` on the Worker.

**What a fork contains — everything, whatever the flag says.** The parent had two branches, two tags, notes, two `refs/entire/*` refs and a `refs/gitflare/*` ref.

| Fork made with | Refs in the fork |
| --- | --- |
| REST, flag omitted | all of the parent's refs |
| REST, `default_branch_only: false` | all |
| REST, `default_branch_only: true` | all |
| binding `fork(name)` | all |
| binding `fork(name, { defaultBranchOnly: true })` | all |

`defaultBranchOnly` — fails (no effect). The fork response carries an initial `token` like a create response: for two forks that token listed the fork's refs, and its `?expires=` suffix was 24 h after creation; its scope and whether it appears in the fork's token list were not checked. The fork response adds `objects` (33, 120, 19 in three runs); `info()` on the fork has `source: "artifacts:gitflare-spike-a-eu/gitflare-spike-a-main"`.

**Timing.** The REST call and the binding call both returned only when the fork was usable: an `info()` immediately afterwards succeeded and the list showed `status: "ready"`. No `FORK_IN_PROGRESS` or 409 was seen. Small repository: 2.0–2.9 s. The 37 MiB repository: 6.6 s. Time growing with size suggests a copy, not a shared object store.

**Two remotes — works.** In a clone of the fork, the parent added as `upstream` with its own read token (`http.<url>.extraHeader` per remote) fetches normally.

**Token scoping — works.** The fork's write token pushes to the fork; against the parent it gets `remote: Invalid or expired token` (403), for fetch and push alike. The parent's token is refused by the fork the same way.

**Merging back with ordinary git — works.** In a clone of the parent: `git fetch <fork remote> session/1`, `git merge --no-ff FETCH_HEAD`, `git push` to the parent with the parent's write token.

**Deleting the parent — the fork survives.** After `DELETE` on the parent (202), the fork still cloned in full and passed `git fsck`; its `source` still names the deleted parent.

**Size reporting — partial** (analytics only, 15-minute samples, late). Neither `GET …/repos/:name`, the repository list, the namespace record nor the binding's `info()` carries a size. The GraphQL Analytics API has a dataset `artifactsStorageAdaptiveGroups` with `max { repositorySizeBytes }` by `repositoryName` and `repositoryNamespace`. It reports each fork as its own row:

```txt
2026-10-02T16:45:00Z gitflare-spike-a-main  270336
2026-10-02T16:45:00Z gitflare-spike-a-fork1 270336
2026-10-02T16:45:00Z gitflare-spike-a-fork2 270336
```

270,336 bytes is the floor for a repository of a few kilobytes. Later samples, for the 36.6 MiB repository and the fork made from it with no pushes of its own beyond three small commits:

```txt
2026-10-02T17:00:00Z gitflare-spike-a-big     42663936
2026-10-02T17:00:00Z gitflare-spike-a-bigfork 40992768
2026-10-02T17:45:00Z gitflare-spike-a-big     42758144
2026-10-02T17:45:00Z gitflare-spike-a-bigfork 41107456
```

**A fork is reported as a separate repository at nearly its parent's size**: 41 MB for the fork next to 42.7 MB for its parent. This is one analytics field, `repositorySizeBytes`. It shows what is reported per repository; it does not show whether the two share objects physically, and nothing was billed during the test (billing starts 2026-10-14), so whether a fork is charged in full is still open. Plan as if it is. The dataset has one sample per repository every 15 minutes and is published late (the 17:00 sample was not yet visible at 17:10). Repositories deleted at 17:06 still had rows in the 17:45 sample, so a deletion does not leave the storage figures at once; how long it takes was not observed.

What it means: a per-session fork is a complete, independent repository, counted on its own. Deleting forks after merge or abandonment is required, as decided. Because a fork copies all refs, forking a sibling transcript repository would copy every checkpoint; sessions should fork only the code repository. The pre-import size check has to be done by gitflare (measure the clone), and the analytics dataset is the only way to read stored size afterwards — it is sampled, not live.

## 4. Push events to a Workflow

Run: `spikes/artifacts-git/worker` (the `PushEvents` Workflow), `git-tests.sh <env> events`, then the Workflows REST API to read each instance.

**Config shape — works as `artifacts.md` says.**

```jsonc
"triggers": {
  "events": [{
    "type": "cf.artifacts.repo.pushed",
    "filter": { "namespace": "gitflare-spike-a-eu" },
    "targets": [{ "type": "workflow", "workflow_name": "gitflare-spike-a-push-events" }]
  }]
}
```

`wrangler deploy` printed `workflow: gitflare-spike-a-push-events` and `event triggers: 1`. The shape in Cloudflare's "Build and deploy on push" guide is rejected:

```txt
✘ [ERROR] Processing wrangler.docs-shape.jsonc configuration:
    - Expected "triggers.events[0].filter" to contain only string "namespace" and "repo_name" fields, but got {"namespace":"…","repoName":"…"}.
    - Expected "triggers.events[0].targets" to be a non-empty array, but got undefined.
```

**What the Workflow receives.** `event.payload` is the object below; the event wrapper adds `timestamp`, `instanceId` and `workflowName`. The instance id equals the event `id`, and the instance's `trigger.source` is `"event"`.

```json
{
  "id": "27f19de5-5468-4cdc-8867-3ae54f1dc918",
  "type": "cf.artifacts.repo.pushed",
  "source": { "namespace": "gitflare-spike-a-eu", "repoName": "gitflare-spike-a-main" },
  "payload": {
    "ref": "refs/heads/main",
    "before": "12e64327c2a16e95068aa29d8223a7ee8e7dc49e",
    "after": "567e6b6a3d4ad6a6bd35aea9de539af3a6ff4af1",
    "commits": [
      {
        "id": "567e6b6a3d4ad6a6bd35aea9de539af3a6ff4af1",
        "message": "E1: single commit to main",
        "messageTruncated": false,
        "timestamp": "2026-10-02T16:40:36.000Z",
        "author": { "name": "spike", "email": "spike@example.com" },
        "committer": { "name": "spike", "email": "spike@example.com" },
        "parents": ["12e64327c2a16e95068aa29d8223a7ee8e7dc49e"]
      }
    ],
    "totalCommitsCount": 1,
    "commitsTruncated": false
  }
}
```

Compared with the documented Queue payload there is an `id`, no `source.type` and no `metadata` block (no account id, subscription id or event timestamp). The first 16 events captured were compared key by key and all had exactly these keys; the 60 after them were read for `source` and `payload` only. **There is no identifier of who or which token pushed** — the same branch pushed with three different tokens produced indistinguishable events.

**Per case.**

| Push | Events | `before` → `after` | `commits` |
| --- | --- | --- | --- |
| One commit to a branch | 1 | old → new | that commit |
| New branch | 1 | zeros → tip | first-parent history from the tip to the root (8 of 8; 20 of "21" on a longer history), not just the new commit |
| Push to a fork created after the trigger was deployed | 1, `source.repoName` is the fork | zeros → tip | as for any new branch: the inherited history is included |
| `refs/entire/checkpoints/…`, `refs/notes/commits`, `refs/gitflare/…` | 1 each | as pushed | `[]`, `totalCommitsCount: 0` — even though the ref points at a commit |
| Lightweight tag; annotated tag | 1 each | zeros → commit SHA; zeros → **tag object** SHA | `[]` |
| One `git push` updating five refs (2 branches, 2 tags, 1 other) | 5 | one per ref | per ref, as above |
| Force push (amended tip) | 1 | old tip → new tip | first-parent history from the new tip to the root (9 of 9); nothing marks it as forced |
| Ref deletion (branch, tag, other) | 1 each | tip → zeros | `[]` |
| 30 commits in one push, one with a 20 kB message | 1 | old → new | 20 commits, `totalCommitsCount: 21`, `commitsTruncated: true`; the long message cut to 4,096 characters with `messageTruncated: true` |
| Merge commit bringing in two fork commits | 1 | old → merge | the merge commit only (`totalCommitsCount: 1`) |
| `git push` with nothing to send | 0 | | |
| isomorphic-git push of an unchanged ref | 1 | `before` = `after` | `[]` |

A deletion, verbatim:

```json
{"id":"d13fbbcc-…","type":"cf.artifacts.repo.pushed","source":{"namespace":"gitflare-spike-a-eu","repoName":"gitflare-spike-a-rerun"},"payload":{"ref":"refs/heads/e4-b","before":"4dbe739e20afe69e1896f04c2151ae159a51d0df","after":"0000000000000000000000000000000000000000","commits":[],"totalCommitsCount":0,"commitsTruncated":false}}
```

**One event per ref — confirmed.** There is no per-push grouping id: the five events of one push share nothing but arrival time.

**Ordering — not preserved.** Instance creation times (`queued`) for pushes made in a known order:

```txt
16:52:52.764Z  refs/tags/e4-light   608ab924 → 00000000    (the deletion, pushed second)
16:52:52.930Z  refs/tags/e4-light   00000000 → 608ab924    (the creation, pushed first)
17:04:59.x     three deletions                              (pushed after the force push)
17:05:01.700Z  refs/heads/e4-a      0d7bd224 → 760a6be9    (the force push)
```

**Latency.** Instances were created 1–2 s after the push returned and started running 0.1–3.6 s after that.

What it means: the namespace-wide trigger is the right route, and it sees forks made later. The handler must be idempotent and order-independent: on any event, read the ref's current value and compare it with what gitflare last processed, rather than applying `before → after`. `totalCommitsCount` is not a count once truncated, and `commits` is not "the new commits" for a new branch, a force push or a merge — compute the range from the repository. Attribution stays with the fork name, as planned. Events for `refs/entire/*` arrive with the commit SHA in `after`, which is enough to index a checkpoint.

## 5. Writing from a Worker with no container

Run: `spikes/artifacts-git/worker`, routes `/iso/commit`, `/thin/commit`, `/iso/merge`, `/relay/ff`. Tokens are minted through the binding (`repo.createToken()`); isomorphic-git speaks HTTPS with Basic auth to the repository's `remote`. Wall and CPU time are from `wrangler tail`. `limits.cpu_ms` was raised to 300,000, but nothing came near the 30 s default.

Three ways to commit one file to an existing repository:

- **checkout** — `git.clone({ depth: 1 })` with checkout into an in-memory filesystem, write the file, `add`, `commit`, `push`.
- **plumbing** — `git.clone({ depth: 1, noCheckout: true })`, then `writeBlob` / `writeTree` along the path / `writeCommit` / `push`.
- **thin** — no clone. Read the trees on the file's path with the binding's `readTree`, build the new blob, trees and commit with isomorphic-git in an empty in-memory repository, `packObjects` them, and POST that pack to `git-receive-pack` directly.

Small repository (a few kB, about 60 commits):

| Operation | Verdict | Wall | CPU | In-memory filesystem |
| --- | --- | --- | --- | --- |
| Commit, checkout | works | 1,100 ms | 141 ms | 3 kB |
| Commit, plumbing | works | 938 ms | 64 ms | 3 kB |
| Commit, thin, 2 runs (5 objects / 533-byte pack / 3 binding reads; 3 objects / 351 bytes / 1 read) | works | 451 ms, 396 ms | 24 ms, 17 ms | — |
| Fast-forward merge of a fork branch, depth 50 | works | 1,060 ms | 114 ms | 21 kB |
| True merge of a fork branch, depth 50 | works | 1,823 ms | 269 ms | 22 kB |
| Either merge at depth 1 | fails | 893 ms | 53 ms | `MergeNotSupportedError: Merges with conflicts are not supported yet.` |
| Merge with a real conflict | reported | 909 ms | 106 ms | `MergeConflictError`, `data.filepaths: ["README.md"]`, `bothModified: ["README.md"]` |
| Fast-forward by pack relay | works | 798 ms | 5 ms | — |

Large repository (3,000 files, 48 MB working tree, 36.6 MiB pack, 21+ commits):

| Operation | Verdict | Wall | CPU | In-memory filesystem |
| --- | --- | --- | --- | --- |
| Commit, thin, 2 runs (6 objects, 2 kB pack, 4 binding reads) | works | 682 ms, 601 ms | 47 ms, 26 ms | — |
| Commit, plumbing, depth 1 | works | 8,343 ms | 5,092 ms | 36.9 MB |
| Commit, checkout, depth 1 | works | 9,365 ms | 5,386 ms | 85.7 MB |
| Fast-forward merge, depth 10, no checkout | works | 16,139 ms | 8,162 ms | 75.2 MB |
| True merge, depth 10, no checkout | works | 16,370 ms | 8,897 ms | 75.1 MB |
| Merge at depth 1 | fails | 19,205 ms | 12,102 ms | same misleading `MergeNotSupportedError` |
| Clone with checkout plus fork fetch, depth 10 (branch already merged, so no merge work) | works | 22,952 ms | 14,113 ms | 123.6 MB |
| Fast-forward by pack relay (7 objects, 26 kB pack) | works | 1,036 ms | 15 ms | — |

Each row is a single run unless it says otherwise; nothing was repeated enough to give a spread. Every result was checked from outside with real git: clone, `git log --graph`, `git fsck` clean, merge commits with two parents.

Observations:

- **No limit was hit**, but the clone-based paths sit close to one. Fetching the fork's branch into the parent's clone downloaded a second full pack (75 MB after a 37 MB clone): isomorphic-git's shallow fetch from a second remote did not negotiate away what it already had. With a checkout on top, the filesystem alone held 123.6 MB in an isolate documented at 128 MB. It ran. Where it stops fitting was not measured; the filesystem held about twice the pack size without a checkout and more than three times with one.
- **A merge needs history.** At depth 1 isomorphic-git finds no merge base and reports it as a conflict error. The depth has to reach the fork point; depth 10 and 50 were enough here, and how deep is enough is not knowable in advance without the fork point's distance.
- **The thin commit cost the same on both repositories**: its work is the path depth (one `readTree` per directory) plus one small POST, and none of it touches the rest of the repository.
- **The relay's cost followed the change, not the repository**, in the one large run (a 26 kB pack of 7 objects against a 37 MiB repository): `want <fork tip>` / `have <parent tip>` to the fork's `git-upload-pack` returned `ACK <parent tip>` and a pack of exactly the missing objects; that pack is sent unchanged to the parent's `git-receive-pack` with `<parent tip> <fork tip> refs/heads/main`. This only fast-forwards. The spike buffers the whole pack in memory, so a large change would need the two requests streamed into each other; that, and any pack larger than 26 kB, was not tested. The spike decides "is it a fast-forward" by looking for the parent tip in the binding's `log()` of the fork branch; `log()` is documented as following first parents only (not checked live), so that is not a complete ancestry test.
- **A server quirk the relay had to work around**: without side-band, Artifacts ends the upload-pack reply with a flush-pkt (`0000`) after the pack's SHA-1 trailer. Its own receive-pack answers `500 Internal Server Error` when given those four extra bytes; with them trimmed it answers `unpack ok`.
- `git-receive-pack` reports a stale old value as `ng refs/heads/main stale ref` (section 1), so the thin commit and the relay are safe against a concurrent writer: retry on `ng`.

Verdicts: commit into an existing repository — **works**. Fast-forward merge — **works**. True merge — **works** at this size, **partial** as a general answer.

What it means for the design:

- Decision files in the sibling repository: write them with the thin path. No container, no clone, tens of milliseconds on both repository sizes tested. The "writer behind a port" stays, but its first implementation can be the Worker one.
- The merge: if gitflare merges by fast-forward (rebase-and-fast-forward or squash produced elsewhere), the relay did it in a Worker without reading the repository; it needs streaming before it can be trusted with a large change. A true merge commit in a Worker worked up to the 37 MiB tested; beyond that it is unmeasured, and because memory held runs at two to three times the pack size, the container fallback from `artifacts.md` should stay for larger repositories unless a tree-level merge is built on binding reads (not attempted).
- Whatever performs the merge must check fast-forward-ness itself and pass the expected old value; the server accepted a non-descendant commit when the old value was right.

## 6. Reading through the binding

Run: `POST /binding/shapes` and `POST /binding/diff` on the Worker.

**Shapes — as the published types say.** Trimmed, verbatim:

```jsonc
// info()
{ "id": "phdpppjxsk059djh", "name": "gitflare-spike-a-main", "description": "GF-12 spike", "defaultBranch": "main",
  "createdAt": "2026-10-02T16:34:35.008Z", "updatedAt": "2026-10-02T16:34:35.494Z", "lastPushAt": null,
  "source": null, "readOnly": false, "remote": "https://<account-id>.artifacts.cloudflare.net/git/gitflare-spike-a-eu/gitflare-spike-a-main.git" }

// log({ ref: "main", limit: 3 })[0]  and  readCommit(hash)  — identical shape
{ "hash": "89e0eb51a4ff3c5940f6f1b9e0aa7d62d1af2b24", "treeHash": "6e4adb740b483b73d1a2e819f274892a49b76171",
  "message": "E9: pushed with initial token", "author": { "name": "spike", "email": "spike@example.com" },
  "committer": { "name": "spike", "email": "spike@example.com" },
  "parents": ["f05e77abf1204eb6a0db0eb102905936b69b9a6b"], "authoredAt": 1790959973, "committedAt": 1790959973 }

// readTree(treeHash)
[ { "name": "README.md", "mode": "100644", "hash": "458d2b297901156ff55e89c714d30707201244e1", "type": "blob" },
  { "name": "src", "mode": "40000", "hash": "6fe307516b422ade8308ac83ccdbff683334b13d", "type": "tree" } ]

// readFile({ ref: "main", path: "src/a.ts" })  → Blob, type "text/plain;charset=utf-8", size 20
// readBlob(hash)                                → Blob, type "", size 17
// listTokens()                                  → { tokens: [{ id, scope, state: "active", createdAt, expiresAt }], total: 3 }  (revoked and expired ones are left out)
```

`log()` returns the full commit message (20,009 characters came back untruncated). `lastPushAt` was `null`, and `updatedAt` unchanged, after dozens of pushes over half an hour, on every repository, over REST too.

**What `ref` accepts.**

| `ref` | `log()` |
| --- | --- |
| `main`, `feature`, `e4-a` (short branch name) | commits |
| `v0.1`, annotated `v0.2` (short tag name) | commits (the annotated tag is peeled) |
| a full commit SHA, including a checkpoint commit and a notes commit | commits |
| `refs/heads/main`, `heads/main`, `refs/tags/v0.2`, `tags/v0.1` | `[]` |
| `HEAD` | `[]` |
| `refs/entire/checkpoints/E3/CHECKPOINT3`, `refs/notes/commits` | `[]` |
| an unknown ref | `[]` (no throw) |

`readFile({ ref: <commit sha>, path })` works. Edge cases: a missing path and a directory both give `null`; `readCommit` of an unknown 40-hex hash gives `null`; `readCommit` of a 7-character hash throws `INVALID_INPUT` (10100) "Invalid hash: expected a 40-character SHA-1 hex hash."; `readTree` given a commit hash throws `INTERNAL_ERROR` (10400).

**A diff between two commits — works, at acceptable cost.** `/binding/diff` walks both trees with `readTree`, descending only into directories whose hashes differ, then optionally loads both sides of each changed file with `readBlob`.

| Repository, range | Changed files | Calls | Wall | CPU |
| --- | --- | --- | --- | --- |
| Small, root → head, with blobs | 3 | 2 `readCommit`, 4 `readTree`, 4 `readBlob` (51 bytes) | 239 ms (163 ms for the trees) | 7 ms |
| Large (3,000 files), root → head | 108 | 2 `readCommit`, 223 `readTree` | 1,758 ms | 47 ms |
| Large, with blobs | 108 | + 212 `readBlob` (3.4 MB) | 2,851 ms | 69 ms |

`git diff --stat` on the same range reported the same 108 files. Calls were issued concurrently per directory level; no rate limit or subrequest limit was met.

What it means: the list of changed files and both sides of each can be assembled from the binding without real git, in a couple of seconds for a 100-file change. The cost is one `readTree` per changed directory on each side, so it follows the size of the change, not of the repository. What the binding does not give: the textual hunks (run a diff library over the two blobs in the Worker), rename detection (compare blob hashes of added and deleted paths for exact renames; similarity is up to us), the merge base (walk `parents` from `readCommit`; `log()` is documented as first-parent only, which was not checked live), and the list of refs. Non-branch refs must be addressed by SHA — from the push event's `after`, or from gitflare's own index.

## Other observations

- **Operations counted.** `artifactsEventsAdaptiveGroups` for the namespace over the whole session: `read` 745, `pull` 77, `push` 76, `token_create` 54, `delete` 8, `fork` 7, `create` 5, plus namespace calls and 16 errors — 994 in total. Binding reads (`readTree`, `readBlob`, …) are counted as `read` events; whether they are billed operations is still not stated anywhere.
- **Repository delete** returns `202` with the repository id; a `GET` straight afterwards is `10200: Repository not found`.
- **A namespace can be deleted**, though no document lists the route: `DELETE /accounts/<account-id>/artifacts/namespaces/gitflare-spike-a-eu` returned `204` once its repositories were gone, and the namespace list was empty afterwards. Not tried on a namespace that still had repositories.
- In `wrangler tail`, the Workflow's invocations show `outcome: "canceled"` although every instance completed (`status: "complete"` over REST). Do not alert on that field.

## Cleanup

Everything created for these tests was deleted on 2026-10-02 and checked afterwards through the API: the Worker `gitflare-spike-a-git`, the Workflow `gitflare-spike-a-push-events`, twelve repositories (`gitflare-spike-a-main`, `-ro`, `-fork1` to `-fork5`, `-big`, `-bigfork`, `-rerun`, `-rerun-ro`, `-rerun-fork`) and the namespace `gitflare-spike-a-eu`. The final listing showed no Artifacts namespaces and no Workflows, and one Worker that predates the test. Nothing is left over.

## Not tested

- Deleting the default branch, and whether `HEAD` can be repointed.
- Rate limits and their responses.
- The Queue event route (only `triggers.events` was in scope).
- A true merge on a repository too large for the isolate — the failure mode when the memory limit is actually exceeded was not reached.
- A tree-level three-way merge built on binding reads.
- Delivery guarantees for events (duplicates, loss): none seen in 76 events, which proves little.
- The equivalent REST calls through curl with an API token: the live run used the MCP client.
