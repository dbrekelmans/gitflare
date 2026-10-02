# Unmodified Entire CLI capturing into a sibling Artifacts repository

Observed 2026-10-02 on a live account.

What ran: the released Entire CLI **v0.11.3** (`entire_darwin_arm64.tar.gz`, checksum verified,
unpacked into a scratch directory, never installed), git 2.55.0, `wrangler@4.147.0`, and real
headless Claude Code 2.1.287 sessions (`claude -p … --model haiku`, eight in total) — no hook
payloads were replayed. Two Artifacts repositories in one namespace: `gitflare-spike-e-code` and
`gitflare-spike-e-checkpoints`. Scripts and exact steps: [`spikes/entire-on-artifacts/`](../../../spikes/entire-on-artifacts/README.md).
In the output below the account id is written `<account-id>`, and `<code>` / `<sibling>` stand for
`https://<account-id>.artifacts.cloudflare.net/git/gitflare-spike-e-ns/gitflare-spike-e-{code,checkpoints}.git`.

## What this changes

1. **No fork of the Entire CLI is needed to capture into a sibling Artifacts repository.** A
   hand-written `.entire/settings.json` with `checkpoint_remote: {"provider": "artifacts", "repo":
   "git/<namespace>/<sibling>"}` makes the unmodified CLI push every checkpoint to the sibling. The
   "fork in the meantime" fallback can be dropped; an upstream provider would only buy the CLI flag
   and a nicer `repo` value.
2. **A git credential helper is the only token route that works in both directions**, and it needs
   `credential.useHttpPath=true` so the two repositories on one host get different tokens.
   `ENTIRE_CHECKPOINT_TOKEN` pushes fine but reads look in the *code* repository and report
   "checkpoint not found"; with provider `github`/`gitlab` they go to that public host with the
   token attached. Do not set the variable anywhere in gitflare, and never use those two provider
   names.
3. **Artifacts accepts `refs/entire/checkpoints/<shard>/<id>`**, so the default `git-refs` backend
   is the one to use. The legacy branch backend also works but is not needed, and it has a side
   effect: the sibling's `HEAD` starts pointing at `entire/checkpoints/v1`.
4. **A commit trailer without a checkpoint is a normal state, and can be permanent.** The checkpoint
   push is fail-soft (the code push goes through, the developer sees two terse lines), and when
   Entire fails to condense a session the commit still carries a trailer whose checkpoint was never
   written. The forge must show "evidence pending" and "evidence missing" rather than assume the
   sibling has what the trailer names.
5. **A write token for the sibling can rewrite or delete any checkpoint.** Artifacts accepted a
   force-push and a delete on a ref under `refs/entire/`. Every developer needs sibling write access
   to push checkpoints, so the sibling is not tamper-proof evidence on its own; the forge should
   index a checkpoint when it arrives if it wants to detect later rewrites.
6. **A pre-configured repository needs no `entire enable`.** A fresh clone carrying the three
   committed files installs the git hooks on the first prompt and links the first commit.
   `commit_linking: "always"` removes the prompt for a human committing at a terminal.
7. **A plain `git clone` of the sibling is empty.** With the `git-refs` backend nothing is under
   `refs/heads/`; "one extra clone" to take the evidence elsewhere means
   `git fetch <sibling> '+refs/entire/*:refs/entire/*'`.
8. **Reading works exactly as the research note describes**, including the cumulative transcript
   and its slice offsets. Each checkpoint ref had two commits (`Checkpoint:` then `Finalize
   transcript for Checkpoint:`), so the reader must take the ref tip and expect a second push.

Corrections made to `spec/research/entire-capture.md` and `spec/research/artifacts.md` in the same
pull request are listed at the end.

## 1. Routing without a fork — `works`

**Ran.** `seed.sh`: `entire enable --agent claude-code --telemetry=false`, then replaced
`.entire/settings.json` with:

```json
{
  "enabled": true,
  "telemetry": false,
  "commit_linking": "always",
  "strategy_options": {
    "checkpoint_remote": {
      "provider": "artifacts",
      "repo": "git/gitflare-spike-e-ns/gitflare-spike-e-checkpoints"
    }
  },
  "checkpoints": { "primary": { "type": "git-refs" } }
}
```

committed it with `.entire/.gitignore` and `.claude/settings.json`, pushed to `<code>`. Then a fresh
clone, one headless Claude Code prompt that edits and commits, and `git push origin main`.

**Came back.**

```
$ entire status
● Enabled · branch main
  Agents · Claude Code
  Checkpoints sync to: dedicated checkpoint remote (git/gitflare-spike-e-ns/gitflare-spike-e-checkpoints)

$ git push origin main
[entire] Pushing 1 checkpoint ref(s) to checkpoint remote.... done
To <code>
   b7866e9..a4bccf7  main -> main

$ git ls-remote <sibling>
83a5561a7aaa00d24579c38aafd46ec307c5090b	refs/entire/checkpoints/SE/01M3YQP715MH9266Q4XVX1D8SE
```

The one thing that does not accept the provider name is the CLI flag, and it only warns:

```
$ entire enable --agent claude-code --telemetry=false --checkpoint-remote artifacts:git/gitflare-spike-e-ns/gitflare-spike-e-checkpoints
Warning: invalid --checkpoint-remote format: unsupported provider "artifacts" (supported: github, gitlab)
  Installed 8 hooks for Claude Code - Anthropic's CLI coding assistant
  ✓ Configured project
```

**Means.** The route the research note derived from the code holds end to end: the settings file is
not validated against a provider list, the first path segment `git` passes the same-owner check, and
the URL is built from the push remote's host. No change to the CLI is required. The smallest change
that would be *nice* is one more `case` in `parseCheckpointRemoteFlag`; gitflare does not need it
because the forge writes the settings file. Not tested: a code repository that is a fork with a
different name pushing to the main repository's sibling (the same-owner check compares only the
`git` segment, so it should pass, but no fork was created here).

## 2. Authentication — `partial` (credential helper `works`; `ENTIRE_CHECKPOINT_TOKEN` push only)

**Ran.** Git config `credential.useHttpPath=true` plus `git-credential-artifacts`, which returns the
token for the repository named in `path=`. Then the same operations with the helper holding only the
code repository's token and `ENTIRE_CHECKPOINT_TOKEN` set. Reads were made from a clone with no
local checkpoint refs, with `git-shim` logging the git commands the CLI runs.

**Came back.** Helper, push — the helper is asked once per repository:

```
16:38:34 get host=<account-id>.<…> path=git/gitflare-spike-e-ns/gitflare-spike-e-code.git
16:38:35 get host=<account-id>.<…> path=git/gitflare-spike-e-ns/gitflare-spike-e-checkpoints.git
```

Helper, read (`entire checkpoint explain --commit HEAD~1`):

```
● Checkpoint 01M3YQP715MH9266Q4XVX1D8SE
  session  66d922ab-5b8b-4ce4-9ec3-decdfaf4012a
  …
git ls-remote <sibling> refs/entire/checkpoints/SE/01M3YQP715MH9266Q4XVX1D8SE [auth-header-in-env=0]
git fetch --no-auto-gc --no-tags <sibling> +refs/entire/checkpoints/SE/01M3YQP715MH9266Q4XVX1D8SE:refs/entire/checkpoints/SE/01M3YQP715MH9266Q4XVX1D8SE [auth-header-in-env=0]
```

Environment variable, push (helper without the checkpoint token; first without the variable as a
control):

```
[entire] Pushing 1 checkpoint ref(s) to checkpoint remote...
[entire] Checkpoint ref push failed; retrying 1 ref(s) individually... pushed 0 of 1
   … fatal: could not read Username for '<sibling>': terminal prompts disabled

$ ENTIRE_CHECKPOINT_TOKEN=<full token, including ?expires=…> git push origin main
[entire] Pushing 1 checkpoint ref(s) to checkpoint remote... done
```

Environment variable, read, provider `artifacts` — the fetch goes to the code repository:

```
$ ENTIRE_CHECKPOINT_TOKEN=<token> entire checkpoint explain --commit HEAD~1 --no-pager --short
checkpoint not found: 01M3YQP715MH9266Q4XVX1D8SE
git fetch --no-auto-gc --no-tags <code> +refs/heads/entire/checkpoints/v1:refs/entire-fetch-tmp/entire/checkpoints/v1 [auth-header-in-env=1]
git ls-remote <code> refs/entire/checkpoints/SE/01M3YQP715MH9266Q4XVX1D8SE [auth-header-in-env=1]
```

Environment variable, read, provider `gitlab` (local override, **dummy** token value; the sandbox
blocked the connection):

```
git ls-remote https://gitlab.com/git/gitflare-spike-e-ns/gitflare-spike-e-checkpoints.git refs/entire/checkpoints/SE/01M3YQP715MH9266Q4XVX1D8SE [auth-header-in-env=1]
```

Token handling by Artifacts itself, with plain `git ls-remote <sibling>`:

| Presented as | Result |
|---|---|
| nothing | `could not read Username … terminal prompts disabled` |
| helper: username `x`, password = token without `?expires=` | ok |
| `Authorization: Bearer <full token>` | ok |
| `Authorization: Bearer <token without ?expires=>` | ok |
| `Authorization: Basic x-access-token:<token without ?expires=>` | ok |
| `Authorization: Basic x-access-token:<full token>` | ok |
| the code repository's token | `remote: Invalid or expired token` / HTTP 403 |

**Means.** Use a credential helper and nothing else. It covers the push in the `pre-push` hook and
every read, with no change to Entire, and it can refresh an expiring token. It must be registered
with `credential.useHttpPath=true`: without the path git cannot tell the code repository from the
sibling, and tokens are strictly per repository. `ENTIRE_CHECKPOINT_TOKEN` is confirmed unusable for
gitflare, for the reason the research note gave from the code: reads are redirected. Fixing that
needs a change in the CLI (`fetchURLResolved`), which gitflare no longer has a reason to make.
`http.<url>.extraHeader` in git config was not tested with Entire (the Bearer form works with plain
git).

## 3. Refs — `works` (git-refs); legacy branch backend also `works`

**Ran.** The pushes above; a force-push and delete of a scratch ref under `refs/entire/`; then a
fresh clone with `{"checkpoints": {"primary": {"type": "git-branch"}}}` in an untracked
`.entire/settings.local.json`, one edit-and-commit session, `git push origin main`.

**Came back.** git-refs: one ref per checkpoint, ULID ids, shard = last two characters:

```
f7eb5850e80286e5724a205f5801ac07185f2fe6	refs/entire/checkpoints/NW/01M3YQQJVN37X48WND4YW3N1NW
83a5561a7aaa00d24579c38aafd46ec307c5090b	refs/entire/checkpoints/SE/01M3YQP715MH9266Q4XVX1D8SE
```

Rewriting a ref outside `refs/heads/` (`a`, `b` are unrelated commits):

```
$ git push <sibling> <a>:refs/entire/spike/nonff
 * [new reference]   21285fae… -> refs/entire/spike/nonff
$ git push <sibling> <b>:refs/entire/spike/nonff          # refused by the git client, before sending
hint: Updates were rejected because a pushed branch tip is behind its remote
$ git push --force <sibling> <b>:refs/entire/spike/nonff
 + 21285fa...b5fdccd b5fdccd8… -> refs/entire/spike/nonff (forced update)
$ git push <sibling> :refs/entire/spike/nonff
 - [deleted]         refs/entire/spike/nonff
```

Legacy backend: a 12-hex id, and a branch in the sibling:

```
2b61d1e Legacy backend commit …  Entire-Checkpoint: 40896ba8ff1a
$ git push origin main
[entire] Pushing entire/checkpoints/v1 to checkpoint remote... done
$ git ls-remote --symref <sibling>
ref: refs/heads/entire/checkpoints/v1	HEAD
cd96739bab14f3d376c556fdb24bd8fd0d47be5f	refs/heads/entire/checkpoints/v1
```

with the checkpoint at `40/896ba8ff1a/` on that branch and `sessions[].*` paths prefixed
`/40/896ba8ff1a/…`.

**Means.** The `git-branch` fallback in the research note is not needed. If it is ever used, expect
the sibling's `HEAD` to resolve to the checkpoint branch (the repository was created with default
branch `main`, which does not exist there). Artifacts does not enforce fast-forward-only updates on
these refs: a force-push and a delete were both accepted, so any holder of a sibling write token can
replace or remove a checkpoint. Not tested: whether a push to `refs/entire/*` emits a
`cf.artifacts.repo.pushed` event (needs a deployed Worker; out of this task's set-up), and two
developers pushing the legacy branch concurrently.

## 4. The read path the forge needs — `works`

**Ran.** `git init --bare ckpt.git && git -C ckpt.git fetch <sibling> '+refs/*:refs/*'`, then
`git -C <code clone> log -1 --format=%B <sha> | read_checkpoint.py ckpt.git` for the two commits of
one two-turn session (the second turn was `claude -p --resume <session id>`).

**Came back.** A plain clone gets nothing; the explicit fetch gets the refs:

```
$ git clone <sibling> plain
warning: You appear to have cloned an empty repository.
```

Second checkpoint (trimmed):

```
trailers: ['01M3YQQJVN37X48WND4YW3N1NW']
ref: refs/entire/checkpoints/NW/01M3YQQJVN37X48WND4YW3N1NW  tip: f7eb5850…  root: /
history:
  f7eb585 1cd1dbd| Finalize transcript for Checkpoint: 01M3YQQJVN37X48WND4YW3N1NW
  1cd1dbd | Checkpoint: 01M3YQQJVN37X48WND4YW3N1NW
tree:
  100644 blob dd2bfc74…      71	0/content_hash.txt
  100644 blob 15a84328…  219272	0/full.jsonl
  100644 blob 13ba590b…    1217	0/metadata.json
  100644 blob 4a25598f…     109	0/prompt.txt
  100644 blob 8440239e…    5178	0/transcript.jsonl
  100644 blob 05397191…     598	metadata.json
root metadata.json:
  "cli_version": "0.11.3", "checkpoint_id": "01M3YQQJVN37X48WND4YW3N1NW", "strategy": "manual-commit",
  "branch": "main", "checkpoints_count": 1, "files_touched": ["README.md"],
  "sessions": [{"metadata": "/0/metadata.json", "transcript": "/0/full.jsonl",
    "compact_transcript": "/0/transcript.jsonl", "content_hash": "/0/content_hash.txt", "prompt": "/0/prompt.txt"}],
  "token_usage": {"input_tokens": 26, "cache_creation_tokens": 690, "cache_read_tokens": 67347, "output_tokens": 456, "api_call_count": 3}
session 0 metadata.json:
  "session_id": "66d922ab-5b8b-4ce4-9ec3-decdfaf4012a", "created_at": "2026-10-02T16:39:05.528476Z",
  "agent": "Claude Code", "model": "claude-haiku-4-5-20251001", "turn_id": "0c264ba79861",
  "checkpoint_transcript_start": 50, "transcript_lines_at_start": 50, "compact_transcript_start": 6,
  "session_metrics": {"turn_count": 1},
  "initial_attribution": {"agent_lines": 1, …, "agent_percentage": 100, "metric_version": 2},
  "prompt_attributions": [{"checkpoint_number": 1, …}]
full.jsonl: 77 lines, 1 chunk(s); this checkpoint = lines[50:] (27 lines)
  last line before slice: assistant: "Done. Added 'hello from session one' to README.md and committed with message 'Add greeting"
    user: "Now append the line 'second turn' to README.md and commit it with the message 'Second line"
    …
    assistant: "Done. Added 'second turn' to README.md and committed with message 'Second line'."
transcript.jsonl: 11 lines; compact_transcript_start=6; slice:
    {'v': 1, 'agent': 'claude-code', 'cli_version': '0.11.3', 'type': 'user'} [{"id": "7280c0de-…", "text": "Now append the line 'second turn' …
    …
prompt.txt: "Now append the line 'second turn' to README.md and commit it with the message 'Second line'. Do nothing else."
content_hash.txt: sha256:2c3e854d… | matches sha256(full.jsonl): True
```

The first checkpoint of the same session holds 50 `full.jsonl` lines and 6 compact lines — exactly
the second one's offsets. Line counts per commit on the two refs:

| Commit | Subject | `full.jsonl` lines | `transcript.jsonl` lines |
|---|---|---|---|
| `df224fb` | `Checkpoint: …SE` | 44 | 5 |
| `83a5561` | `Finalize transcript for Checkpoint: …SE` | 50 | 6 |
| `1cd1dbd` | `Checkpoint: …NW` | 71 | 10 |
| `f7eb585` | `Finalize transcript for Checkpoint: …NW` | 77 | 11 |

**Means.** The layout, both metadata shapes, the leading-`/` session paths, the trailers on the
checkpoint commit, `content_hash.txt` and the slicing rule in the research note all match what the
CLI wrote. Details the forge's reader should know:

- `checkpoint_transcript_start` is absent on a session's first checkpoint (zero is omitted) while
  `compact_transcript_start: 0` is present; treat a missing value as 0.
- The first commit on a ref is written at commit time, mid-turn, and lacks the end of the turn; the
  `Finalize` commit at turn end completes it. Both were queued and pushed together here because the
  push came after the turn. An agent that pushes inside the turn will deliver the first commit
  alone and the second on a later push.
- Root and session `checkpoints_count` were 1 on both checkpoints; it is not a running total.
- `full.jsonl` is large relative to the work: 193 KB for a four-call session (26 of its 50 lines are
  Claude Code `attachment` lines), 219 KB cumulative after the second turn. Transcript content
  includes absolute local paths.
- The checkpoint commits were unsigned here because the isolated git config had no signing set up.

## 5. Ordering and failure — `works` (checkpoint first; failure never blocks the code push)

**Ran.** `GIT_TRACE=1 git push origin main`; then a push with an invalid checkpoint token, a push
with `checkpoint_remote` pointed (local override) at a repository that does not exist, and a push
with no checkpoint credential at all.

**Came back.** Order, from the trace:

```
18:38:34.432985 trace: run_command: .git/hooks/pre-push origin <code>
[entire] Pushing 1 checkpoint ref(s) to checkpoint remote.... done
18:38:35.522728 run_processes_parallel: done
18:38:35.522794 trace: run_command: git send-pack --stateless-rpc --helper-status --thin --no-progress <code>/ --stdin
To <code>
   b7866e9..a4bccf7  main -> main
```

Invalid token — everything the developer sees:

```
$ git push origin main
[entire] Pushing 1 checkpoint ref(s) to checkpoint remote...
[entire] Checkpoint ref push failed; retrying 1 ref(s) individually... pushed 0 of 1
To <code>
   a4bccf7..dd648c8  main -> main
exit=0

$ entire status
  Checkpoints sync to: dedicated checkpoint remote (git/gitflare-spike-e-ns/gitflare-spike-e-checkpoints)
  1 checkpoint not yet pushed
```

The reason is only in `.entire/logs/entire.log`:

```
"msg":"git-refs pre-push: checkpoint ref push failed; refs left queued", … "error":"… git push: exit status 128 (remote: Invalid or expired token fatal: unable to access '<sibling>/': The requested URL returned error: 403) (checkpoint ref recovery failed: fetch failed: remote: Invalid or expired token …"
```

Missing repository — the same two lines on screen, and the same server response as a bad token:

```
remote: Invalid or expired token
fatal: unable to access 'https://<account-id>.artifacts.cloudflare.net/git/gitflare-spike-e-ns/gitflare-spike-e-missing.git/': The requested URL returned error: 403
```

The ref stayed in `.git/entire-checkpoint-push-queue.jsonl` through three failed pushes and was sent
by the next push that had a working credential, even though that push had no code to send
(`Everything up-to-date`).

Two further observations from the same runs:

- In a run where Claude Code could not write its transcript file (the first attempt, inside a
  sandbox), `prepare-commit-msg` had already added `Entire-Checkpoint: 01M3YQM9RM702QH2DFDGRXSS95`
  to the commit when `post-commit` logged `condensation failed … transcript not found`. No
  checkpoint ref was ever created for that id. A second commit, made by hand in a clone whose
  history had been reset during testing, ended the same way (`failed to get commit object: object
  not found`; cause not isolated).
- In that failed case `post-commit` ran `git ls-remote <sibling> refs/entire/checkpoints/95/…`: a
  commit can make a network call to the sibling, with credentials. In the successful runs the
  helper log shows no call at commit time.

**Means.** The research note's reading is confirmed: checkpoint first, synchronous, fail-soft, with
the ref left queued. The forge will regularly see a code commit whose checkpoint has not arrived,
and occasionally one whose checkpoint never will. Both need a visible state on the change page. The
on-screen message does not say why the push failed, and Artifacts answers a missing repository like
a bad token, so gitflare's own tooling (the login command or the helper) should be what tells a
developer their sibling token is wrong.

## 6. A pre-configured repository — `works`

**Ran.** Fresh clones of `<code>` (which carries `.entire/settings.json`, `.entire/.gitignore`,
`.claude/settings.json`), `entire` on `PATH`, no `entire enable`. Agent commit: one prompt that
edits and commits. Human commit: an edit-only prompt, then `human-commit.sh` — `git commit -am`
under a pseudo-terminal with the agent's environment variables removed — once with the committed
`commit_linking: "always"`, once with `{"commit_linking": "prompt"}` in `settings.local.json`,
answering `n`.

**Came back.**

```
$ ls .git/hooks | grep -v sample          # after clone: nothing
$ session.sh clone2 "Append the line … then commit …"
$ ls .git/hooks | grep -v sample
commit-msg  post-commit  post-rewrite  pre-push  prepare-commit-msg
$ git log -1 --format=%B
Add greeting

Entire-Checkpoint: 01M3YQP715MH9266Q4XVX1D8SE
```

```
=== committed commit_linking=always, human at a TTY
[main d3e62b0] Human commit (always)
d3e62b0 Human commit (always) | trailer=[01M3YRNB02200R8PJMMXQDGJBK]

=== commit_linking=prompt via settings.local.json, answer n
Entire: Active Claude Code session detected
  Last prompt: Append the line 'edit for prompt' to README.md. Do not commit and do not run ...

Link this commit to session context?
  [Y]es / [n]o / [a]lways (remember my choice): n
[main a3b9656] Human commit (prompt, declined)
a3b9656 Human commit (prompt, declined) | trailer=[]
```

**Means.** The forge can pre-configure a repository by committing three files; a developer needs the
`entire` binary and a credential helper, nothing else. Keep `commit_linking: "always"` in the
committed file: with the default, a human can decline and the commit arrives unlinked. A commit made
in a fresh clone *before* the first prompt has no hooks and therefore no trailer (the hook directory
was empty until the first prompt). Also seen: the same human commit run from a shell that still had
Claude Code's environment variables (`CLAUDECODE`, `CLAUDE_CODE_*`) showed no prompt under
`commit_linking: "prompt"` and added the trailer; which variable causes that was not isolated.

## Other observations

- **Partial clone works.** Protocol v2 advertises `fetch=shallow filter sideband-all`
  (`agent=gitty/1.0`), and `git clone --bare --filter=blob:none <code>` produced a clone with 6
  objects missing (the blobs). Entire's `filtered_fetches` was not exercised.
- **The token format is not the documented one.** Tokens from `wrangler artifacts repos create` look
  like `art_v2_x_<40 hex>?expires=<unix seconds>`, and that initial token expired exactly 24 hours
  after creation.
- **Namespaces can be deleted.** `DELETE /accounts/<account-id>/artifacts/namespaces/<namespace>`
  returned 204 for the empty namespace; the route is in Cloudflare's OpenAPI description but not on
  the REST docs page, and wrangler 4.147.0 has no command for it. `wrangler artifacts repos delete
  <name> --namespace <ns> --force` deletes a repository.
- **The Entire CLI calls `api.github.com`** on `enable`, `status` and `checkpoint explain` even with
  telemetry off (seen as blocked connections in the sandbox; what it requests was not inspected).
- **Claude Code inside a sandbox that denies writes to `~/.claude/projects` captures nothing**: the
  hooks run and the trailer is added, but there is no transcript to condense. A cloud workspace must
  let the agent persist its transcript where Entire's hook is told to find it.

## Cost and cleanup

- Model: eight headless Claude Code sessions on Haiku 4.5, $0.209 in total at list price as reported
  by `claude -p --output-format json` ($0.017–$0.045 each). Cloudflare: Artifacts operations only,
  inside the included allowance and before billing starts — $0.
- Created: namespace `gitflare-spike-e-ns`, repositories `gitflare-spike-e-code` and
  `gitflare-spike-e-checkpoints`. All three deleted on 2026-10-02 (repositories with wrangler, the
  namespace with the REST route above); `artifacts namespaces list` no longer shows the namespace.
  Local token files deleted. Nothing left over.

## Corrections made to the research notes

`spec/research/entire-capture.md`:

- "An unmodified CLI can probably already target a sibling repo" and the matching "Could not verify"
  entries (refs outside `refs/heads/`, the no-code-change route, `ENTIRE_CHECKPOINT_TOKEN`, the
  credential helper in `pre-push`, fast-forward enforcement, `--filter=blob:none`) now state what
  was observed and point here.
- The legacy-backend line said the v1 branch "is not pushed to a remote that has no remote-tracking
  refs yet, so it cannot become the default branch". With a `checkpoint_remote` it was pushed to an
  empty sibling and the sibling's `HEAD` now points at it.
- The Artifacts token format quoted from Cloudflare's page (`art_v1_…`) is annotated with the
  observed `art_v2_x_…`.

`spec/research/artifacts.md` (smallest possible edits; the Artifacts live test owns the rest):

- Token format, and the statement that Basic auth needs the suffix stripped (both forms work).
- "Partial clone may not work" / "Whether `--filter=blob:none` works": it works over protocol v2.
- The initial token's TTL (24 hours), and the existence of a namespace delete route.
