# Container git and CI with credentials kept outside

Observed 2026-10-02 on a live account.

Everything below was run against a Workers Paid account with `wrangler@4.147.0`, compatibility date `2026-10-01`, a Durable Object of our own driving `ctx.container` under the `durable_object` scheduling policy. The code and the exact commands are in `spikes/container-git/` (routes in its README; container-side scripts in `scripts/container/`). Output is verbatim, trimmed; `<account-id>`, `<host>` (the Artifacts git host) and `<cf-registry-id>` replace identifiers. Timings are single runs unless a range is given: read them as orders of magnitude.

Each section ends with a verdict: `works`, `fails`, `partial` or `not tested`.

## What this changes

1. **git through the egress gateway works end to end, so no credential needs to enter a container.** With Internet access off and `interceptOutboundHttps` on the Artifacts host, `clone`, `fetch` of a fork, `merge` and `push` all succeeded, including a 33 MB chunked `git-receive-pack` body. The short-lived-token fallback in `spec/research/sandbox-ci.md` is not needed. The gateway also enforced per-repository scope: a session container could not push to the parent.
2. **Never do a full clone of an Artifacts repository on a request path; shallow is 30× faster.** A 7,198-commit, 33 MB repository took 59–62 s to clone in full (24 s before Artifacts sent the first byte) and 1.9 s with `--depth=1`. Fetching a one-commit fork branch into a full clone took 19.5 s; into a shallow clone with `--depth=2`, 1.0 s. Diff with rename detection and merge are 5–60 ms either way. Diff and merge can live in a container: start (0.5 s) + shallow clone (2 s) + fork fetch (1 s) + merge and push (0.4 s) is about 4 s cold for a 50 MB repository.
3. **The deployer does not need Docker.** A Worker that uses only the managed image deploys with Docker absent. The managed image has no git, but installing it once in a container with Internet access and taking a snapshot gives an image every other Durable Object can start offline in ~0.5 s. A Dockerfile image still needs Docker at deploy (`wrangler deploy` fails without it).
4. **Snapshots are incremental, listable and deletable.** Sizes are deltas (a second snapshot with nothing changed was 141 bytes). They appear in the account's managed registry under `cloudchamber-snapshots/<base image digest>` and `wrangler containers images delete` removes them. The note's "cannot be listed or deleted" holds only for the Worker API.
5. **A container stops ~10–15 s after its Durable Object goes idle unless an inactivity timeout is set; traffic through an intercept does not count as activity; a pending `monitor()` does, for up to 15 minutes.** The alarm-based keep-alive in the research note is needed and works.
6. **Live CI logs are straightforward.** Output lines reach the Durable Object ~45 ms after the container prints them, a second client polling SQLite sees them as they arrive, and a piped process kept running for 200 s after the request that started it had returned, as long as the Durable Object kept reading. The "piped output is killed with SIGPIPE when the request ends" constraint did not reproduce.
7. **Pointing every TLS client at the container CA alone hangs tools silently when only some hostnames are intercepted.** `pnpm install` sat for ten minutes with no output and no error. Use the CA-only variables only with a `*` intercept; otherwise leave the system trust store in place.
8. **`fork()` and `import()` are slow or unreliable at 33 MB.** `fork()` of the 33 MB repository returned after 41 s (3.4 s for a tiny one). `import()` of the same repository from GitHub failed twice with `UPSTREAM_UNAVAILABLE` after 66 s. A change opening or a repository being imported cannot be a synchronous request.
9. **A coding agent's model traffic needs no AI Gateway token at all**: the gateway entrypoint forwarded Claude Code's request through the Worker's AI binding. The run stopped at the provider credential (`402 Insufficient wholesale credits`), so the model call itself is unproven.

## 1. Driving a container from a Durable Object

### Deploying with the managed image; Docker

Run: `wrangler deploy` with `containers[0]` having no `images`, and `WRANGLER_DOCKER_BIN=/nonexistent/docker DOCKER_HOST=unix:///nonexistent.sock`.

```txt
The following containers are available:
- Box (durable_object)

Uploaded gitflare-spike-c-container (3.61 sec)
Deployed gitflare-spike-c-container triggers (1.85 sec)
```

The same deploy after adding `"images": { "git": { "dockerfile": "./Dockerfile" } }`:

```txt
✘ [ERROR] The Docker CLI is needed to build the configured image before deploying but could not be launched.
  If you cannot run Docker locally, use a prebuilt registry image instead of a Dockerfile path for the affected Durable Object-managed Container images.
```

With Docker running, the deploy built and pushed the image to `registry.cloudflare.com/<account-id>/gitflare-spike-c-container-box-git` and took 112 s in total (77 s of it in "Uploaded").

Verdict: **works** without Docker for the managed image; a Dockerfile image needs Docker. For the installer: ship no Dockerfile. Either prepare the workspace image as a snapshot (below), or reference a digest-pinned image already in the deployer's managed registry.

### Start time

Run: `POST /box/<name>/start`, which calls `start()` and then awaits `exec(["true"])`; `readyMs` is the time from `start()` to that process exiting.

| Case | `readyMs` |
| --- | --- |
| Managed image, a Durable Object that never ran a container (about 20 runs, `lite` and `standard-*`) | 92–281 |
| Managed image, same Durable Object, `destroy()` then `start()` straight away (3 runs) | 1192, 1254, 1320 |
| Restore of a 76 MB snapshot (git installed) in another Durable Object (17 runs) | 341–633 for 14 of them; 2769 (`standard-1`), 2570 and 3924 (`lite`) |
| Dockerfile image, first start after the push | 8132 |
| Dockerfile image, later starts in other Durable Objects | 515, 356, 432; 326 after destroy |

`start()` itself returned in 0 ms every time. `/proc/uptime` inside a container 40 s after its start read 528 s, so the VM was booted before we asked for it.

One Durable Object failed to start three times over two minutes (first start of a new object, 87 s after a deploy) while other objects started normally; 25 minutes later the same object started in 281 ms:

```txt
{"kind":"monitor-rejected","detail":"Error: The container connection is temporarily unavailable, try again shortly"}
{"kind":"op-error","detail":"start: Error: The container connection is temporarily unavailable, try again shortly"}
```

Here `monitor()` rejected 21 s after `start()` and the first `exec()` 50 s after.

Verdict: **works**. The 648 ms median in the research note is conservative for a first start; a restart of the same object costs about a second more. Starts can fail for minutes on a single object, so the sandbox port needs a retry with a different object name or a visible "could not start" state.

### Instance types

Run: `start({ image: "cloudflare/debian-trixie", instance })`, then `nproc`, `MemTotal`, `df /`.

| `instance` | Result | `nproc` | `MemTotal` | Disk |
| --- | --- | --- | --- | --- |
| `lite` | started | 1 | 469,264 kB | 1.9 G |
| `basic` | `TypeError: Invalid container instance type.` | | | |
| `standard-1` | started | 1 | 4,401,424 kB | 7.5 G |
| `standard-2` | started | 1 | 6,498,576 kB | 12 G |
| `standard-3` | started | 2 | 6,498,576 kB | 15 G |
| `standard-4` | started | 4 | 9,644,304 kB | 19 G |
| `dev`, `standard` | `TypeError: Invalid container instance type.` | | | |
| `{ vcpu: 1, memoryMib: 4096, diskMb: 8000 }` | started | 1 | 4,401,424 kB | 7.5 G |
| `{ vcpu: 0.5, memoryMib: 1024, diskMb: 4000 }` | `start()` did not throw; first `exec()` failed with `Error: The container has not been started` | | | |
| `{ vcpu: 2, memoryMib: 4096, diskMb: 8000 }` | same | | | |

Verdict: **works** for `lite` and `standard-1` to `standard-4`, as documented. Memory seen inside `standard-3` and `standard-4` is 6.2 GiB and 9.2 GiB, not the 8 and 12 GiB in the limits table; `lite` shows 458 MiB, not 256. An invalid custom size is not rejected by `start()`: it surfaces on the first `exec()`.

### Running a command, exit codes, streaming

```txt
POST /box/q1a/exec {"cmd":"node --version; uname -a; nproc; … ; which git curl python3 tar timeout setsid tail; echo done; exit 7"}
{"exitCode":7,"ms":248,"stdout":"v24.20.0\nLinux … 6.18.54-cloudflare-microvm-2026.9.16 … x86_64 GNU/Linux\n1\n…\n/usr/bin/tar\n/usr/bin/timeout\n/usr/bin/setsid\n/usr/bin/tail\ndone\n","stderr":"sh: 1: free: not found\n"}
```

A trivial `exec()` round trip was 10–40 ms. Streaming, with the client's arrival time in parentheses and the Durable Object's read time in brackets:

```txt
(client +175ms) [+29ms] line 1 at 1790959181.150
(client +1188ms) [+1034ms] line 2 at 1790959182.162
(client +2188ms) [+2039ms] line 3 at 1790959183.166
(client +3187ms) [+3043ms] line 4 at 1790959184.170
(client +4192ms) [+4047ms] line 5 at 1790959185.175
(client +5201ms) [+5049ms] to-stderr
(client +5230ms) [+5049ms] exit=3
```

Verdict: **works**. Nonzero exit codes resolve normally; output arrives line by line.

### A long-running background process with output in a file

Run: the documented launcher (`setsid sh -c … >stdout.log 2>stderr.log`, exit code written atomically), `stdout: "ignore"`, the request returns at once.

```txt
POST /box/q1a/bg → {"pid":24,"dir":"/var/lib/p/job1"}                 (HTTP 200 in 0.10 s)
8 s later:  pid / stderr.log / stdout.log;  "26 fc19c7ab-955e-4e9d-9bb0-138c03588924";  tick 8, tick 9
40 s later, no requests in between:  job1 exit-code=5 lines=40
```

The same question for a process whose output is piped to the Durable Object, started from a request that returns immediately while the reader runs under `ctx.waitUntil()`:

```txt
POST /box/q1b/ci {"detach":true,"steps":[{"name":"loop","cmd":"for i in $(seq 1 200); do echo piped $i; sleep 1; done"}]}
→ {"run":"23feab20","detached":true}
later: q1b rows 201 [… "line":"piped 200"},{… "line":"{\"name\":\"loop\",\"exitCode\":0,\"ms\":200370}"}]
```

A shorter run with `trap … PIPE` in the script recorded no `SIGPIPE`. In both runs a `monitor()` promise was also pending.

Verdict: **works**, both ways. The research note's "a process with piped stdout receives `SIGPIPE` once the request that started it ends" did not happen while the Durable Object kept reading the stream. Files remain the right choice for anything that must survive a Durable Object restart (a deploy cut an open stream about 45 s later with `Network connection lost`, while the container and a file-backed job carried on).

### What keeps the container alive

Run: a process in the container reports every 5 s through `interceptOutboundHttp("hb.spike")` to a different Durable Object, and nothing calls the container's own Durable Object after setup. "Alive for" is first to last heartbeat.

| Box | Setup | Alive for |
| --- | --- | --- |
| n1 | no inactivity timeout, no `monitor()` | 9 s (3 heartbeats) |
| n2 | `setInactivityTimeout(120 s)`, no `monitor()` | 110 s |
| n4 | same, no network traffic at all | stopped (`running: false` when asked after 300 s) |
| n3 | `setInactivityTimeout(60 s)` and an alarm every 30 s | still alive at 285 s, when last checked |
| k1 | no inactivity timeout, `monitor()` pending | 920 s; stopped ~25 s after the 15-minute mark |
| k2 | 120 s timeout, `monitor()` pending | 1010 s: 15 minutes plus the 120 s |
| k3 | 60 s timeout, `monitor()` pending (alarms ended at 360 s) | 955 s: 15 minutes plus 60 s |

When the platform stopped a container this way, nothing ran in the Durable Object: its event log shows no `monitor()` outcome, only a fresh `constructed running=false` at the next request. A later `exec()` fails with `Error: exec() cannot be called on a container that is not running.`

The k boxes each received one `state` request 766 s after starting, by which point all three had already outlived their timeouts many times over; their stop times line up with the 15-minute mark plus the timeout, not with that request.

A deploy while a container was running: the open stream ended about 45 s later, the next request constructed a new Durable Object instance with `running=true`, and the container, its files and its background job were intact.

Verdict: **works** as the research note describes, with three additions: (a) without a timeout the container is gone within ~15 s; (b) the container's own traffic through an intercept is not activity; (c) a pending `monitor()` holds the Durable Object, and so the container, for up to 15 minutes regardless of the timeout — convenient for short jobs, and a source of surprise bills if relied on by accident. Keep-alive stays an explicit alarm.

## 2. git against Artifacts with the token outside the container

Setup: the container is restored from a snapshot of the managed image with git 2.47.3 installed, `enableInternet: false`. Before `start()`, the Durable Object mints repository tokens with the binding and registers `interceptOutboundHttps("<host>", ctx.exports.GitGateway({ props }))`; the tokens travel in `props`. The gateway allows only `info/refs` and `git-upload-pack` (plus `git-receive-pack` when the box may push) for the repositories it holds a token for, sets `Authorization: Bearer <token>` and calls `fetch()`. Git in the container gets `GIT_SSL_CAINFO=/etc/cloudflare/certs/cloudflare-containers-ca.crt` and a plain remote URL.

Inside the offline container: `/etc/cloudflare/certs/cloudflare-containers-ca.crt` exists (648 bytes), `/etc/resolv.conf` reads `nameserver 1.1.1.1`, and `getent hosts example.com` fails after a 20 s wait.

Push of a new repository (`scripts/container/seed-small.sh`):

```txt
remote: https://<host>/git/gitflare-spike-c-ns/gitflare-spike-c-small.git
To https://<host>/git/gitflare-spike-c-ns/gitflare-spike-c-small.git
 * [new branch]      main -> main
push exit=0
ls-remote exit=0
no credential in .git/config
no token in env
```

A session container holding a write token for its fork only (`session-change.sh`):

```txt
TIME 1119 ms exit=0 :: git clone -q https://<host>/git/gitflare-spike-c-ns/gitflare-spike-c-small-fork.git /work/fork
 src/{greet.js => greeting.js} | 2 +-
 src/math.js                   | 3 +++
TIME 360 ms exit=0 :: git push -q origin change
--- negative: push to the parent, which this gateway has no token for
remote: Forbidden by gateway
fatal: unable to access 'https://<host>/git/gitflare-spike-c-ns/gitflare-spike-c-small.git/': The requested URL returned error: 403
--- negative: any other host
fatal: unable to access 'https://github.com/vuejs/core.git/': Could not resolve host: github.com
```

The forge container, with tokens for parent and fork (`forge-merge.sh`):

```txt
TIME 1018 ms exit=0 :: git clone -q https://<host>/git/gitflare-spike-c-ns/gitflare-spike-c-small.git /work/parent
TIME 506 ms exit=0 :: git fetch -q fork change
TIME 10 ms exit=0 :: sh -c git diff -M --stat main...fork/change | tail -6
TIME 19 ms exit=0 :: git merge -q --no-ff -m Merge change fork/change
TIME 398 ms exit=0 :: git push -q origin main
*   bccf4b8 Merge change
|\
| * 9879d42 session change
|/
* ff89579 initial
```

The binding then showed `bccf4b88` with two parents on `main`. What the gateway saw for that run (no request carried an `Authorization` header of its own):

```txt
GET gitflare-spike-c-small.git/info/refs?service=git-upload-pack proto=version=2 -> 200 128ms
POST gitflare-spike-c-small.git/git-upload-pack proto=version=2 reqLen=233 -> 200 167ms
GET gitflare-spike-c-small-fork.git/info/refs?service=git-upload-pack proto=version=2 -> 200 73ms
POST gitflare-spike-c-small-fork.git/git-upload-pack proto=version=2 reqLen=317 -> 200 76ms
GET gitflare-spike-c-small.git/info/refs?service=git-receive-pack proto=null -> 200 60ms
POST gitflare-spike-c-small.git/git-receive-pack proto=null reqLen=843 -> 200 150ms
```

Large request bodies: pushing a 33 MB pack (7,198 commits) through the gateway, from a container with Internet access on and the intercept still in place:

```txt
TIME 91062 ms exit=0 :: git push -q artifacts main
POST gitflare-spike-c-big.git/git-receive-pack proto=null reqLen=4 te=null -> 200 97ms
POST gitflare-spike-c-big.git/git-receive-pack proto=null reqLen=null te=chunked -> 200 90385ms
```

Verdict: **works** — clone, fetch of a fork, merge and push, with TLS trusted through `GIT_SSL_CAINFO`, smart-HTTP bodies passed through unmodified (`new Request(request, { headers })`), and a chunked 33 MB upload streamed without buffering in the Worker. A Worker `fetch()` to `*.artifacts.cloudflare.net` in the same account behaves like any client. The intercept also works with `enableInternet: true`, where only the intercepted host is rerouted.

Design consequences: the token-in-container fallback is not needed. The gateway is also where repository scope is enforced, which Artifacts tokens alone cannot express per container. The 91 s is unattributed: no direct push of the same pack was run for comparison.

### The fallback, for comparison

Run: Internet on, no gateway, a `read` token with a 900 s TTL for the big repository in `$ARTIFACTS_TOKEN` (`direct-token.sh`).

```txt
token shape: art_v2_x_<40 hex>?expires=1790962009
TIME 1635 ms exit=0 :: git -c http.extraHeader=Authorization: Bearer <token> clone -q --depth=1 …/gitflare-spike-c-big.git shallow
TIME 39459 ms exit=0 :: git -c http.extraHeader=Authorization: Bearer <token> clone -q …/gitflare-spike-c-big.git full
--- without the token
fatal: could not read Username for 'https://<host>': No such device or address
--- the token on another repository
remote: Invalid or expired token
fatal: unable to access '…/gitflare-spike-c-small.git/': The requested URL returned error: 403
--- push with a read token
remote: Insufficient permissions
fatal: unable to access '…/gitflare-spike-c-big.git/': The requested URL returned error: 403
```

Verdict: **works**, and is not needed. Exposure if it were used: any process in the container can read the token (this test printed it into its own log, which is how its real shape was learned) and use it from anywhere until it expires; it is limited to one repository and to its scope. Through the gateway a full clone took 59–62 s against 39 s direct, and a shallow clone 1.9 s against 1.6 s — one run each, so the gateway's overhead on large transfers is somewhere between nothing and a third.

## 3. The forge's git operations, timed

Repositories: "small" is 4 files and 1 commit. "Big" is `vuejs/core` `main`: 7,198 commits, 702 files, a 33 MB pack as cloned from GitHub (GitHub reports 46 MB), 7.8 MB working tree; a full clone from Artifacts produced an 84 MB `.git`. The change on the fork is one commit that renames a file with an edit, edits a second and adds a third. All through the gateway, Internet off.

| Operation | small, `standard-1` | big, `standard-1` | big, `lite` |
| --- | --- | --- | --- |
| `git clone` (full) | 1.0 s | 62.1 s (58.6 s for the fork) | 203.5 s |
| `git clone --depth=1` | | 1.9 s (`.git` 2.1 MB) | |
| `git clone --filter=blob:none` | | 26.5 s (`.git` 23 MB) | |
| `git fetch fork change` into the full clone | 0.5 s | 19.5 s | 23.0 s |
| `git fetch --depth=2 fork change` into the shallow clone | | 1.0 s | |
| `git diff -M --stat main...fork/change` | 10 ms | 7 ms | 200 ms |
| `git diff -M main...fork/change` (patch) | 5 ms | 7 ms | 196 ms |
| `git merge-tree --write-tree main fork/change` | 9 ms | 5 ms | 101 ms |
| `git merge --no-ff` | 19 ms | 56 ms | |
| `git push origin main` (one merge commit) | 0.40 s | 0.35 s | |
| Session side: `git push origin change` to the fork | 0.36 s | 0.79 s | |
| `repo.fork()` through the binding | 3.4 s | 41.3 s | |

Where the full-clone time goes: the gateway saw 24.2 s between sending the `git-upload-pack` request and receiving response headers, and 19.0 s for the one-commit fork fetch. The time is Artifacts producing the pack, not the container.

The shallow path, in full (`clone-variants.sh`): `--depth=1` clone of the parent, `git fetch --depth=2 fork change`, then `merge-base` resolved to the parent's tip and `diff -M` and `merge-tree` gave the same results as in the full clone, with `.git` at 4.0 MB. `--depth=2` was enough because the branch had one commit; in general the fetch depth must be the number of commits on the branch plus one.

Capabilities Artifacts advertised: protocol v2 `fetch=shallow filter sideband-all`, `ls-refs=unborn`, `agent=gitty/1.0`. `--filter=blob:none` worked (promisor remote, 23,426 objects left missing). `--filter=tree:0 --depth=1` failed: `error: RPC failed; HTTP 400 … fatal: expected 'packfile'`.

`env.ARTIFACTS.import()` of `https://github.com/vuejs/core` failed twice, 66 s and 68 s after the call: `ArtifactsError: The upstream service is unavailable. Please retry.` (`UPSTREAM_UNAVAILABLE`). The repository was loaded by cloning from GitHub inside a container (5.4 s) and pushing through the gateway (91 s) instead.

Verdict: **works**. Diff and merge belong in a container: the git work is milliseconds even on `lite`, and a cold run on a 50 MB repository is about 4 s if every clone and fetch is depth-limited. A full clone must never sit on a request path, and `lite` is too slow for anything but the smallest repositories (3.3× slower on network transfer, ~25× on git CPU work). `--filter=blob:none` is available, but slower than `--depth=1` and not needed for diff or merge. `fork()` at 41 s means opening a session's fork is a background step with a visible state.

## 4. A CI run

Setup: container restored from the git snapshot, `standard-1`, Internet off, `interceptOutboundHttps("*")`. The gateway adds a read token for the repository and passes `registry.npmjs.org` through unchanged; everything else gets `403`. Each step is one `exec(["timeout", "--kill-after=5", "<seconds>", "sh", "-c", cmd])`; the Durable Object reads stdout and stderr concurrently and inserts every line into SQLite with its own clock.

```txt
{"run":"eca58f6b","passed":true,"steps":[{"name":"checkout","exitCode":0,"ms":1541},{"name":"install","exitCode":0,"ms":967},{"name":"slow","exitCode":0,"ms":5020},{"name":"test","exitCode":0,"ms":584}]}

+  910ms install  out  npm warn deprecated left-pad@1.3.0: use String.prototype.padStart()
+  917ms install  out  added 1 package in 580ms
+  975ms slow     out  emitted 1790961189477   [DO read 42ms after the container printed it]
+ 1979ms slow     out  emitted 1790961190479   [DO read 44ms after the container printed it]
+ 2984ms slow     out  emitted 1790961191482   [DO read 46ms after the container printed it]
+ 6481ms test     out  ✔ add (1.08134ms)
+ 6557ms test     out  ℹ pass 1

gateway: GET …small.git/info/refs?service=git-upload-pack token added -> 200
         GET registry.npmjs.org/left-pad pass-through -> 200
         GET registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz pass-through -> 200
```

A failing run, started with `detach: true` and polled once a second by a second client while it ran:

```txt
poll 1: rows=2 last: slow emitted 2
poll 2: rows=3 last: slow emitted 3
…
poll 6: rows=13 last: fail ✔ add (0.89497ms)
poll 7: rows=33 last: fail {"name":"fail","exitCode":1,"ms":734}
{"run":"f4400fcf","passed":false,"steps":[{"name":"slow","exitCode":0,"ms":6015},{"name":"fail","exitCode":1,"ms":734}]}
```

Failure modes, as the Durable Object sees them:

| What happened | Step result | Other signals |
| --- | --- | --- |
| Step exceeded its `timeout` (3 s) | `exitCode: 124` after 3.0 s | a child the step had started (`sleep 77 &`) was still running afterwards |
| `destroy()` from another request, 4 s into a step | reading the stream threw `Error: Network connection lost.`; no exit code | `monitor()` resolved; `running: false` |
| `signal(9)` to the container's main process, 4 s into a step | `exitCode: 137`, no error | 50 ms later `monitor()` rejected: `Container exited with unexpected exit code: 137`; `running: false` |
| Process ran out of memory on `lite` | `exitCode: 137` after 4 s | container kept running; a repeat left `/proc/uptime` continuous and files intact |
| `exec()` on a container that had just been destroyed | threw `Error: Network connection lost.` or `Error: Container connectivity was lost` | |

Verdict: **works**. Log lines reach the Durable Object as they are produced and the exit code decides the result. Consequences for our runner: (a) `137` is ambiguous — a step killed for memory, and a whole container killed, look identical from the step, so after any non-zero exit check `container.running` (or the `monitor()` outcome) before reporting "tests failed"; (b) `timeout` does not stop a step's children, so run each step in its own process group and kill the group, or destroy the container after a timeout; (c) dependency installs with Internet off work through a `*` intercept with an allow-list, which gives an egress log per run for free.

## 5. Snapshot and restore

The workspace: a `--depth=1` clone of the big repository plus `pnpm install` of its dependencies (416 MB, 20,729 files in `node_modules`; 524 MB used on `/`), on `standard-2`.

| Snapshot | Reported `size` | `snapshotContainer()` took |
| --- | --- | --- |
| Managed image + git (357 MB root filesystem) | 76,222,694 | 7.8 s |
| That, restored, + clone (before dependencies) | 50,403,637 | 8.6 s |
| + dependencies | 256,684,088 | 11.3 s |
| Same container again, nothing changed | 141 | 6.6 s |
| Git snapshot, restored, + Claude Code (224 MB) | 242,633,733 | 9.4 s |

| Restore | `readyMs` |
| --- | --- |
| Git snapshot (76 MB), other Durable Objects, repeatedly | 341–633 |
| Workspace snapshot (257 MB delta), first time, `standard-2` | 12,624 |
| The 141-byte snapshot on top of it, `standard-1` | 11,303 |
| Workspace snapshot onto `lite` (2 GB disk) | 18,635 |
| Workspace snapshot again, same Durable Object after `destroy()` | 298 |
| Workspace snapshot again, a few minutes later | 503 |
| Claude Code snapshot, first time | 6,034 |
| An id that does not exist | `start()` returns; `monitor()` rejects with `Error: Snapshot "…" was not found.` |

What survived (`workspace-check.sh` in the restored container, Internet off):

```txt
/tmp/marker: marker-tmp
/run/marker: cat: /run/marker: No such file or directory
/root/marker: marker-root
/workspace/MARKER: marker-ws
git: bc92dd6 Merge change status-lines=1
node_modules=416M pnpm=12.4.2
 Test Files  6 passed (6)
      Tests  72 passed (72)
TIME 5667 ms exit=0 :: sh -c pnpm exec vitest run packages/shared 2>&1 | tail -5
```

A `sleep 9999` left running before the snapshot was not there afterwards; only the entrypoint (`sleep infinity`) ran. A snapshot taken in an Internet-on container restored into an Internet-off one, into other Durable Objects, and onto a different instance type. `inspect().image` of a restored container was the base image reference (`registry.cloudflare.com/<cf-registry-id>/cf/production/node-24-trixie@sha256:6cef…`), not the empty string the docs describe.

After the tests, `wrangler containers images list` showed every snapshot:

```txt
REPOSITORY                                                TAG
cloudchamber-snapshots/6cef8f20f606945a…3147be1c          rootfs-set-199c009817df…
cloudchamber-snapshots/6cef8f20f606945a…3147be1c          rootfs-snapshot-059683e8410f…
…                                                         (5 rootfs-set and 5 rootfs-snapshot tags for the 5 snapshots taken)
```

and `wrangler containers images delete <repository>:<tag>` deleted each one. The repository name is the digest of the managed base image.

Verdict: **works**. Saving takes 7–11 s. Restoring is ~0.5 s once the snapshot has been used recently, and 6–19 s the first time for a few hundred MB — so a session that resumes after a long pause should expect roughly ten seconds, not one. Files anywhere on the root filesystem survive, including `/tmp`; `/run` and processes do not. Snapshots are stored as layers in the account's managed registry (so they presumably count against its 50 GB), are incremental, and can be listed and deleted with Wrangler; gitflare still has to record the ids, but it can garbage-collect. Not tested: restoring after the base image changes, and the 30-day expiry.

One trap found on the way: in a container that intercepts a single hostname with Internet on, running `pnpm install` with `SSL_CERT_FILE`, `CURL_CA_BUNDLE`, `NODE_EXTRA_CA_CERTS` and `GIT_SSL_CAINFO` all pointing at the container CA hung for ten minutes with no output and a load average of 0.00. Without those variables the same install finished in 39 s. Which of the four mattered was not isolated.

## 6. Stretch: a coding agent in the container

Run: Claude Code 2.1.280 installed with `npm install --global` in a container with Internet access (7.3 s) and saved as a snapshot — no Dockerfile, no registry push. Then a container restored from it with Internet off and a `*` intercept. The container gets the guide's variables (`ANTHROPIC_BASE_URL` pointing at `gateway.ai.cloudflare.com/v1/<account-id>/gitflare-spike-c-gw/anthropic`, `ANTHROPIC_API_KEY=provided-by-worker`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`, `IS_SANDBOX=1`). Departing from the guide, the gateway entrypoint does not add a `cf-aig-authorization` token: it drops `x-api-key` and forwards the request with `env.AI.gateway("gitflare-spike-c-gw").run({ provider: "anthropic", endpoint, headers, query })`, so the credential is the Worker's AI binding. The gateway was created with authentication on. Prompt: `Reply with the single word: pong`, model `claude-haiku-4-5-20251001`.

```txt
claude exit=1
… "is_error":true,"num_turns":1,"subtype":"success","api_error_status":402,"result":"API Error: 402 Insufficient wholesale credits. Please add additional credits on the AI Gateway Cloudflare dashboard to continue using provider models.","type":"result","duration_ms":1261 …

gateway: HEAD gateway.ai.cloudflare.com api/hello -> 404
         POST gateway.ai.cloudflare.com v1/messages model=claude-haiku-4-5-20251001 hadApiKeyHeader=true -> 402
           {"success":false,…"error":[{"code":2021,"message":"Insufficient wholesale credits. …"}],"name":"AiGatewayError","httpCode":402,…}
```

Verdict: **partial**. Proven: the agent image can be built without Docker; Claude Code starts headless as root in the offline container; its request to the gateway hostname is intercepted; the authenticated gateway accepts the request from the binding with no token anywhere; the failure comes back to Claude Code as an ordinary API error within 1.3 s. Not proven: an actual model response, streaming of it, and tool use, because the account has no Unified Billing credits and no stored Anthropic key, and adding either is a billing change outside this task. No model cost was incurred. Notes for the design: the gateway needs credits or a provider key before a hosted session can run, so the installer must check for one; Claude Code exited `1` here with `is_error: true` and `subtype: "success"`, so the outcome has to be read from `is_error` and `api_error_status`, as the research note says.

## Smaller observations

- Artifacts tokens minted through the binding have the form `art_v2_x_<40 hex>?expires=<unix seconds>`, not `art_v1_…`.
- `env.ARTIFACTS.list()` entries carried `remote`, `status` and `jurisdiction` (`"unrestricted"`), and `lastPushAt: null` for a repository that had been pushed to minutes earlier. `repo.info()` on the fork returned `source: "artifacts:gitflare-spike-c-ns/gitflare-spike-c-big"`.
- `repo.fork()` did not return until the fork was usable (3.4 s and 41.3 s); no `FORK_IN_PROGRESS` was seen.
- `DELETE /accounts/<account-id>/artifacts/namespaces/<namespace>` on an empty namespace returned `204` and the namespace was gone. That route is not on the documented list.
- Deleting the Worker does not delete its container application: `wrangler containers list` still showed `gitflare-spike-c-box` (`ready`, 0 instances) until `wrangler containers delete`.

## Spend and cleanup

Estimated spend: under $0.25 at list price, before included allowances. About 40 containers ran, most for the 5–15 minutes of their inactivity timeout: roughly 150 minutes of `standard-1`, 35 of `standard-2` and 120 of `lite`, with little active CPU (memory ≈ $0.13, CPU and disk ≈ $0.03). Artifacts operations and storage were within the allowance and are not billed before 2026-10-14. No model call was served.

Deleted: the Worker, the container application, the Dockerfile image, all five snapshots, the four Artifacts repositories and their namespace, and the AI gateway. Nothing is left over.
