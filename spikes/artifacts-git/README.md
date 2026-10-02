# Spike: Artifacts git semantics (GF-12)

Throwaway code behind `spec/research/live/artifacts-git.md`. It creates real, billed resources on a Cloudflare account: do not run it without the project owner's authorisation, a resource-name prefix and a spending limit (see `.bb/AGENTS.md`).

What is here:

- `git-tests.sh` — plain git and curl against an Artifacts remote: token presentation, clones, token failure modes, non-branch refs, forks, the pushes that generate events, and two hand-built `git-receive-pack` requests.
- `worker/` — one Worker (`gitflare-spike-a-git`) with a Workflow that records every push event, and routes that write with isomorphic-git, write with a hand-built pack, relay a pack from a fork to its parent, and read through the binding.

Tool versions used on 2026-10-02: `wrangler@4.147.0`, `isomorphic-git@1.42.6`, git 2.55.0, compatibility date `2026-10-01`.

## 1. Namespace, repositories, tokens (REST)

The live run made these calls through the Cloudflare MCP server's authenticated `cloudflare.request()`. The curl forms below are the same routes and bodies; they were not executed as curl. They need an API token with **Artifacts > Edit**.

```sh
API="https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/artifacts/namespaces"
NS=gitflare-spike-a-eu
cf() { curl -sS -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H "Content-Type: application/json" "$@"; }

cf -X POST "$API" -d '{"namespace":"'$NS'","jurisdiction":"eu"}'
cf -X POST "$API/$NS/repos" -d '{"name":"gitflare-spike-a-main"}'
cf -X POST "$API/$NS/repos" -d '{"name":"gitflare-spike-a-ro","read_only":true}'
cf -X POST "$API/$NS/tokens" -d '{"repo":"gitflare-spike-a-main","scope":"read","ttl":86400}'    # T_READ
cf -X POST "$API/$NS/tokens" -d '{"repo":"gitflare-spike-a-main","scope":"write","ttl":86400}'   # T_WRITE
cf -X POST "$API/$NS/tokens" -d '{"repo":"gitflare-spike-a-main","scope":"write","ttl":86400}'   # T_REVOKED, then:
cf -X DELETE "$API/$NS/tokens/<id of T_REVOKED>"
cf -X POST "$API/$NS/tokens" -d '{"repo":"gitflare-spike-a-main","scope":"write","ttl":60}'      # T_SHORT
cf -X POST "$API/$NS/tokens" -d '{"repo":"gitflare-spike-a-ro","scope":"write","ttl":86400}'     # T_RO_WRITE
```

Put the results in an env file outside the repository (tokens are never committed):

```sh
export REMOTE='https://<account-id>.artifacts.cloudflare.net/git/gitflare-spike-a-eu/gitflare-spike-a-main.git'
export RO_REMOTE='https://<account-id>.artifacts.cloudflare.net/git/gitflare-spike-a-eu/gitflare-spike-a-ro.git'
export T_READ='art_v2_…?expires=…' T_WRITE='…' T_REVOKED='…' T_SHORT='…' T_RO_WRITE='…'
# added in step 3:
export FORK_REMOTE='…' T_FORK='…'
```

## 2. Deploy the Worker (before any push whose event you want to see)

```sh
cd worker
npm install
printf '{"SPIKE_KEY":"%s"}\n' "$(openssl rand -hex 24)" > "$TMPDIR/spike-secrets.json"
npx wrangler deploy --dry-run -c wrangler.docs-shape.jsonc   # the documented trigger shape; expected to fail validation
npx wrangler deploy --secrets-file "$TMPDIR/spike-secrets.json"
```

`wrangler.jsonc` binds the namespace and subscribes the Workflow to `cf.artifacts.repo.pushed` filtered by namespace only. Every route requires the `x-spike-key` header; with the secret unset the Worker answers 403 to everything.

## 3. Plain git

```sh
./git-tests.sh /path/to/env auth clones tokens refs
```

Create a fork (after the Worker is deployed, so its pushes test "fork created after the trigger"), mint a write token for it, add `FORK_REMOTE` and `T_FORK` to the env file:

```sh
cf -X POST "$API/$NS/repos/gitflare-spike-a-main/fork" -d '{"name":"gitflare-spike-a-fork1"}'
cf -X POST "$API/$NS/tokens" -d '{"repo":"gitflare-spike-a-fork1","scope":"write","ttl":86400}'
./git-tests.sh /path/to/env tokens forks events raw   # `tokens` again, now that T_SHORT has expired
```

### Run by hand, not part of `git-tests.sh`

These were typed during the first pass and are recorded here as run; the script does not repeat them. `B` is the script's helper: `B() { git -c http.extraHeader="Authorization: Bearer $1" "${@:2}"; }`.

Forks with the flag set each way, then compare the refs with the parent's (each fork's response carries its initial `token`):

```sh
cf -X POST "$API/$NS/repos/gitflare-spike-a-main/fork" -d '{"name":"gitflare-spike-a-fork2","default_branch_only":false}'
cf -X POST "$API/$NS/repos/gitflare-spike-a-main/fork" -d '{"name":"gitflare-spike-a-fork3","default_branch_only":true}'
B "$T_FORK2_INITIAL" ls-remote "$FORK2_REMOTE"
B "$T_FORK3_INITIAL" ls-remote "$FORK3_REMOTE"
```

`fork4` and `fork5` are the same check through the binding (`/binding/fork` in step 5, with the flag unset and `true`); mint a token for each over REST and `ls-remote` it.

The same branch pushed with three different tokens, to compare the events: `T_WRITE` (every push in the script), the repository's initial token from the create response, and the tokens the Worker mints through the binding for its own pushes (step 5):

```sh
git commit --allow-empty -m "pushed with initial token" && B "$T_INITIAL" push "$REMOTE" main
```

A new branch on a history longer than 20 commits (the "20 of 21" case): after the `events` stage, in the fork clone, `git fetch upstream && git checkout -B ff upstream/main`, commit, `git push origin ff`.

Deleting a parent, and the deleted repository's token:

```sh
cf -X DELETE "$API/$NS/repos/<parent>"            # 202
cf "$API/$NS/repos/<parent>"                      # 10200: Repository not found
B "$T_FORK" clone "$FORK_REMOTE" orphan && git -C orphan fsck
B "$T_WRITE" ls-remote "$REMOTE"                  # the deleted parent's token: 403
```

The commit messages `E1` … `E9` in the findings note come from that first, hand-typed pass; the script's `events` stage is the same sequence tidied up.

## 4. Read the recorded events

Each event starts one Workflow instance whose `params` is the event. List and read them:

```sh
WF="https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/workflows/gitflare-spike-a-push-events/instances"
cf "$WF?per_page=100"
cf "$WF/<instance id>"      # .result.params is the event; .result.queued is when it was delivered
```

## 5. Worker routes

All are `POST` with a JSON body and the `x-spike-key` header. `W` is the `workers.dev` URL `wrangler deploy` prints.

```sh
call() { curl -sS -m 300 -X POST "$W$1" -H "x-spike-key: $SPIKE_KEY" -H "content-type: application/json" -d "$2"; echo; }

call /binding/shapes '{"repo":"gitflare-spike-a-main","file":"src/a.ts","refs":["main","refs/heads/main","v0.1","HEAD","<a commit sha>"]}'
call /binding/diff   '{"repo":"gitflare-spike-a-main","base":"<sha>","head":"<sha>","blobs":true}'
call /binding/fork   '{"repo":"gitflare-spike-a-main","name":"gitflare-spike-a-fork5","defaultBranchOnly":true}'

call /iso/commit  '{"repo":"gitflare-spike-a-main","path":"decisions/0001.md","content":"# one\n","mode":"checkout"}'   # shallow clone, checkout, add, commit, push
call /iso/commit  '{"repo":"gitflare-spike-a-main","path":"decisions/0002.md","content":"# two\n","mode":"plumbing"}'   # shallow clone, no checkout, rewrite trees on the path
call /thin/commit '{"repo":"gitflare-spike-a-main","path":"decisions/0003.md","content":"# three\n"}'                    # no clone: binding reads + a hand-built pack

call /iso/merge '{"parent":"gitflare-spike-a-main","fork":"gitflare-spike-a-fork1","branch":"ff","depth":50}'   # depth 0 = full history
call /relay/ff  '{"parent":"gitflare-spike-a-main","fork":"gitflare-spike-a-fork1","branch":"relay"}'           # fast-forward with no clone
```

Fork branches used for the merges, made in a clone of the fork with the parent as `upstream`: `ff` (one commit on top of the parent's `main`), `tm` (same base, after which the parent moves on, giving a true merge), `cf2` (edits a file the parent also edited, giving a conflict), `relay` (one commit on top of the parent's `main`).

CPU and wall time per request come from `npx wrangler tail gitflare-spike-a-git --format json` (`cpuTime`, `wallTime`), not from the Worker: `Date.now()` inside a Worker only advances across I/O.

## 6. The large repository

3,000 files of about 16 kB of base64 text in 60 directories, then 20 commits each touching 5 files: 48 MB working tree, 36.6 MiB pack.

```sh
git init -q -b main big && cd big
python3 - <<'EOF'
import os, base64, random
random.seed(12)
n = 0
for a in range(10):
    for b in range(6):
        d = f"pkg{a:02d}/mod{b}/src"; os.makedirs(d, exist_ok=True)
        for f in range(50):
            body = base64.b64encode(random.randbytes(12000)).decode()
            lines = "\n".join(body[i:i+100] for i in range(0, len(body), 100))
            open(f"{d}/file{f:02d}.ts", "w").write(f"// file {n}\n{lines}\n"); n += 1
EOF
git add . && git commit -qm "big: initial"
for i in $(seq 1 20); do for j in 1 2 3 4 5; do echo "// change $i.$j" >> pkg0$((i%10))/mod$((j%6))/src/file$(printf %02d $((i+j))).ts; done; git commit -qam "big: change $i"; done
git -c http.extraHeader="Authorization: Bearer $T_BIG" push "$BIG_REMOTE" main
```

`gitflare-spike-a-big` is created first like any other repository; `BIG_REMOTE` and `T_BIG` are the `remote` and `token` of that response:

```sh
cf -X POST "$API/$NS/repos" -d '{"name":"gitflare-spike-a-big"}'
```

After the push, fork it through the Worker and mint a token for the fork:

```sh
call /binding/fork '{"repo":"gitflare-spike-a-big","name":"gitflare-spike-a-bigfork"}'
cf -X POST "$API/$NS/tokens" -d '{"repo":"gitflare-spike-a-bigfork","scope":"write","ttl":86400}'
```

Then repeat the step 5 calls with `gitflare-spike-a-big` as the parent and `gitflare-spike-a-bigfork` as the fork, pushing the `ff`, `tm` and `relay` branches to the fork from a clone of it (a blobless clone with a sparse checkout of a few files is enough).

## 7. Storage and operation counts

GraphQL Analytics (`https://api.cloudflare.com/client/v4/graphql`), datasets `artifactsStorageAdaptiveGroups` (`max { repositorySizeBytes }` by `repositoryName`) and `artifactsEventsAdaptiveGroups` (`count` by `eventType`).

## 8. Clean up

```sh
cd worker
npx wrangler workflows delete gitflare-spike-a-push-events
npx wrangler delete --name gitflare-spike-a-git --force
cf "$API/$NS/repos"   # list what is there, then delete every one of them:
for repo in main ro fork1 fork2 fork3 fork4 fork5 big bigfork; do cf -X DELETE "$API/$NS/repos/gitflare-spike-a-$repo"; done
```

Then, once the namespace is empty, `cf -X DELETE "$API/$NS"` — an undocumented route that returned `204` and removed it.
