# Spike: container git and CI with credentials kept outside (GF-13)

Throwaway code behind `spec/research/live/container-git.md`. One Worker (`gitflare-spike-c-container`) with:

- `Box` — a Durable Object that drives a container through `ctx.container` (`durable_object` scheduling policy). Every operation is an HTTP route so the tests can be driven with `curl`.
- `GitGateway` — the `WorkerEntrypoint` that receives the container's intercepted HTTPS requests and adds the Artifacts token (and, for question 6, forwards model requests through the AI binding).
- `Recorder` — a second Durable Object that stores gateway records and heartbeats, so writing them is not activity on `Box`.

It creates billed resources on a real account. Everything it creates is named `gitflare-spike-c-*`.

## Set up

Needs Node 24, `wrangler login` on a Workers Paid account, and Docker only for the second deploy (see step 3).

```sh
cd spikes/container-git
npm install
node -e 'require("fs").writeFileSync(".secrets.json", JSON.stringify({SPIKE_KEY: require("crypto").randomBytes(24).toString("hex")}))'
```

1. For the first deploy, remove the `"images"` line from `wrangler.jsonc` so that only the managed image is used, then deploy with Docker made unavailable:

   ```sh
   WRANGLER_DOCKER_BIN=/nonexistent/docker DOCKER_HOST=unix:///nonexistent.sock npx wrangler deploy --secrets-file .secrets.json
   ```

2. Write `.env` (gitignored) from what Wrangler printed and from `wrangler whoami`:

   ```sh
   SPIKE_URL=https://gitflare-spike-c-container.<subdomain>.workers.dev
   ARTIFACTS_HOST=<account-id>.artifacts.cloudflare.net
   CLOUDFLARE_ACCOUNT_ID=<account-id>
   ```

3. Later (question 1, custom image; question 6), restore the `"images"` line and run `npx wrangler deploy --secrets-file .secrets.json` with Docker running.

`scripts/call.sh METHOD PATH [JSON]` calls the Worker with the shared key. `scripts/run.sh BOX SCRIPT` runs one of `scripts/container/*.sh` inside a box's container; `$H` in those scripts is the Artifacts host, `EXTRA_ENV='{"REPO":"…"}'` adds variables.

## Routes

| Route | What it does |
| --- | --- |
| `POST /box/<name>/start` | `start()` then a first `exec(["true"])`; returns `readyMs`. Body: `image` (`"managed"` or a key of `images`), `snapshot: {id}`, `instance`, `enableInternet`, `inactivityMs`, `monitor: false`, `heartbeat`, `gateway: {repos, allowPush, allowHosts, aiGateway}`, `directToken: {repo, scope, ttl}` |
| `POST /box/<name>/exec` | Runs `cmd` (string = `sh -c`), buffered; `timeoutS`, `env`, `cwd`, `trust: false` (do not point TLS at the container CA only), `token: true` (pass the direct token as `$ARTIFACTS_TOKEN`) |
| `POST /box/<name>/stream` | Same, streamed; each line is prefixed with the ms since `exec()` |
| `POST /box/<name>/bg` | The documented background launcher: output to `<dir>/stdout.log`, exit code to `<dir>/exit-code` |
| `POST /box/<name>/ci` | Steps run under `timeout`; each output line is inserted into the Durable Object's SQLite as it is read. `detach: true` returns the run id at once |
| `GET /box/<name>/log?run=` · `/events` · `/state` | Log rows; start/monitor/alarm events; `running`, `inspect()`, `images` |
| `POST /box/<name>/snapshot` · `/destroy` · `/signal` · `/timeout` · `/keepalive` | `snapshotContainer()`, `destroy()`, `signal()`, `setInactivityTimeout()`, an alarm every `everyMs` for `forMs` |
| `GET /notes/<name>` | Gateway records and heartbeats for that box |
| `POST /artifacts/create|fork|import|delete`, `GET /artifacts/info|log|list` | The Artifacts binding. Tokens are never returned |

## The runs, in order

The snapshot ids below are whatever your own run returns; `$GIT`, `$WS` and `$AGENT` stand for them.

```sh
c=scripts/call.sh

# 1. Driving a container
$c POST /box/q1a/start '{"image":"managed"}'
$c POST /box/q1a/exec '{"cmd":"node --version; exit 7"}'
for t in '"lite"' '"basic"' '"standard-1"' '"standard-2"' '"standard-3"' '"standard-4"' '"dev"' '"standard"' \
  '{"vcpu":1,"memoryMib":4096,"diskMb":8000}' '{"vcpu":0.5,"memoryMib":1024,"diskMb":4000}'; do
  $c POST /box/it/start "{\"image\":\"managed\",\"instance\":$t}"
  $c POST /box/it/exec '{"cmd":"nproc; grep MemTotal /proc/meminfo; df -h / | tail -1"}'; $c POST /box/it/destroy '{}'
done
$c POST /box/q1a/stream '{"cmd":"for i in 1 2 3 4 5; do echo line $i; sleep 1; done; echo to-stderr >&2; exit 3"}'
$c POST /box/q1a/bg '{"dir":"/var/lib/p/job1","cmd":"for i in $(seq 1 40); do echo tick $i; sleep 1; done; exit 5"}'
$c POST /box/q1b/ci '{"detach":true,"steps":[{"name":"loop","cmd":"for i in $(seq 1 200); do echo piped $i; sleep 1; done"}]}'
# keep-alive: a heartbeat process reports through an HTTP intercept to Recorder every 5 s; then leave Box alone
HB='{"dir":"/var/lib/p/hb","cmd":"node -e \"let n=0; setInterval(()=>fetch(\\\"http://hb.spike/hb?n=\\\"+(n++)).catch(()=>{}),5000)\""}'
$c POST /box/n1/start '{"image":"managed","heartbeat":true,"monitor":false}';                      $c POST /box/n1/bg "$HB"
$c POST /box/n2/start '{"image":"managed","heartbeat":true,"monitor":false,"inactivityMs":120000}'; $c POST /box/n2/bg "$HB"
$c POST /box/n3/start '{"image":"managed","heartbeat":true,"monitor":false,"inactivityMs":60000}';  $c POST /box/n3/bg "$HB"
$c POST /box/n3/keepalive '{"everyMs":30000,"forMs":300000}'
$c POST /box/k1/start '{"image":"managed","heartbeat":true}'; $c POST /box/k1/bg "$HB"   # with a pending monitor()
# ...wait, then read the heartbeats without touching Box:
$c GET /notes/n1

# git without Docker: install it in the managed image, snapshot, restore offline everywhere else
$c POST /box/builder/start '{"image":"managed","enableInternet":true,"instance":"standard-1"}'
$c POST /box/builder/exec '{"trust":false,"cmd":"apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends git ca-certificates"}'
$c POST /box/builder/snapshot '{"name":"gitflare-spike-c-gitbase"}'          # -> $GIT

# 2. git through the gateway, Internet off
$c POST /artifacts/create '{"name":"gitflare-spike-c-small"}'
$c POST /box/g1/start "{\"snapshot\":{\"id\":\"$GIT\"},\"instance\":\"standard-1\",\"gateway\":{\"repos\":[\"gitflare-spike-c-small\"],\"allowPush\":true}}"
scripts/run.sh g1 scripts/container/seed-small.sh
$c POST /artifacts/fork '{"name":"gitflare-spike-c-small","to":"gitflare-spike-c-small-fork"}'
$c POST /box/sess/start "{\"snapshot\":{\"id\":\"$GIT\"},\"instance\":\"standard-1\",\"gateway\":{\"repos\":[\"gitflare-spike-c-small-fork\"],\"allowPush\":true}}"
scripts/run.sh sess scripts/container/session-change.sh
$c POST /box/forge/start "{\"snapshot\":{\"id\":\"$GIT\"},\"instance\":\"standard-1\",\"gateway\":{\"repos\":[\"gitflare-spike-c-small\",\"gitflare-spike-c-small-fork\"],\"allowPush\":true}}"
scripts/run.sh forge scripts/container/forge-merge.sh
$c GET /notes/forge
# the fallback: a read token inside the container
$c POST /box/direct/start "{\"snapshot\":{\"id\":\"$GIT\"},\"instance\":\"standard-1\",\"enableInternet\":true,\"directToken\":{\"repo\":\"gitflare-spike-c-big\",\"scope\":\"read\",\"ttl\":900}}"
#   then POST /box/direct/exec with {"cmd": <scripts/container/direct-token.sh>, "token": true, "trust": false, "env": {"H": "$ARTIFACTS_HOST"}}

# 3. the same on a ~50 MB repository (vuejs/core; `import` failed, so it is loaded by a push through the gateway)
$c POST /artifacts/create '{"name":"gitflare-spike-c-big"}'
$c POST /box/loader/start "{\"snapshot\":{\"id\":\"$GIT\"},\"instance\":\"standard-2\",\"enableInternet\":true,\"gateway\":{\"repos\":[\"gitflare-spike-c-big\"],\"allowPush\":true}}"
scripts/run.sh loader scripts/container/load-big.sh
$c POST /artifacts/fork '{"name":"gitflare-spike-c-big","to":"gitflare-spike-c-big-fork"}'
EXTRA_ENV='{"REPO":"gitflare-spike-c-big"}' scripts/run.sh sess2 scripts/container/session-change.sh      # box started like `sess`, for the big fork
EXTRA_ENV='{"REPO":"gitflare-spike-c-big"}' scripts/run.sh forge2 scripts/container/clone-variants.sh    # box started like `forge`, for big + big-fork
EXTRA_ENV='{"REPO":"gitflare-spike-c-big"}' scripts/run.sh forge2 scripts/container/forge-merge.sh
EXTRA_ENV='{"REPO":"gitflare-spike-c-big","NOPUSH":"1"}' scripts/run.sh forgelite scripts/container/forge-merge.sh   # same on "lite"

# 4. CI: Internet off, "*" intercept, Artifacts read token + pass-through for the npm registry
$c POST /box/ci/start "{\"snapshot\":{\"id\":\"$GIT\"},\"instance\":\"standard-1\",\"gateway\":{\"repos\":[\"gitflare-spike-c-small\"],\"allowPush\":false,\"allowHosts\":[\"registry.npmjs.org\"]}}"
$c POST /box/ci/ci "{\"cwd\":\"/\",\"steps\":[
  {\"name\":\"checkout\",\"cmd\":\"git init -q /ws && cd /ws && git remote add origin https://$ARTIFACTS_HOST/git/gitflare-spike-c-ns/gitflare-spike-c-small.git && git fetch -q --depth=1 origin main && git checkout -q --detach FETCH_HEAD\"},
  {\"name\":\"install\",\"cmd\":\"cd /ws && npm install --no-audit --no-fund 2>&1\"},
  {\"name\":\"slow\",\"cmd\":\"for i in 1 2 3 4 5; do echo emitted \$(date +%s%3N); sleep 1; done\"},
  {\"name\":\"test\",\"cmd\":\"cd /ws && npm test 2>&1\"}]}"
$c GET '/box/ci/log?run=<run>'
$c POST /box/ci/ci '{"steps":[{"name":"hang","timeoutS":3,"cmd":"(sleep 77 &) ; sleep 60"}]}'            # timeout
LONG='{"steps":[{"name":"long","cmd":"for i in $(seq 1 100); do echo working $i; sleep 1; done"}]}'
(sleep 4; $c POST /box/ci/destroy '{}') & $c POST /box/ci/ci "$LONG"; wait                                 # destroyed mid-step
(sleep 4; $c POST /box/ci5/signal '{"signo":9}') & $c POST /box/ci5/ci "$LONG"; wait                       # main process killed mid-step
$c POST /box/ci3/ci '{"steps":[{"name":"oom","cmd":"node -e \"const a=[];for(;;)a.push(Buffer.alloc(50e6,1))\""}]}'   # on "lite"

# 5. snapshot and restore of a workspace
$c POST /box/snap/start "{\"snapshot\":{\"id\":\"$GIT\"},\"instance\":\"standard-2\",\"enableInternet\":true,\"gateway\":{\"repos\":[\"gitflare-spike-c-big\"]}}"
scripts/run.sh snap scripts/container/workspace.sh
$c POST /box/snap/snapshot '{"name":"gitflare-spike-c-workspace2"}'           # -> $WS
$c POST /box/rest1/start "{\"snapshot\":{\"id\":\"$WS\"},\"instance\":\"standard-2\"}"
scripts/run.sh rest1 scripts/container/workspace-check.sh

# 6. Claude Code, model traffic through the AI binding (needs a gateway named gitflare-spike-c-gw and Unified Billing credits)
$c POST /box/agentbuild/start "{\"snapshot\":{\"id\":\"$GIT\"},\"instance\":\"standard-1\",\"enableInternet\":true}"
$c POST /box/agentbuild/exec '{"trust":false,"cmd":"npm install --global @anthropic-ai/claude-code@2.1.280"}'
$c POST /box/agentbuild/snapshot '{"name":"gitflare-spike-c-agent"}'          # -> $AGENT
$c POST /box/agent/start "{\"snapshot\":{\"id\":\"$AGENT\"},\"instance\":\"standard-1\",\"gateway\":{\"repos\":[\"gitflare-spike-c-small\"],\"allowHosts\":[],\"aiGateway\":\"gitflare-spike-c-gw\"}}"
#   then exec, with env ANTHROPIC_BASE_URL=https://gateway.ai.cloudflare.com/v1/$CLOUDFLARE_ACCOUNT_ID/gitflare-spike-c-gw/anthropic,
#   ANTHROPIC_API_KEY=provided-by-worker, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1, IS_SANDBOX=1:
#   claude --print --output-format stream-json --verbose --dangerously-skip-permissions --no-session-persistence \
#     --model claude-haiku-4-5-20251001 --max-turns 2 -- "Reply with the single word: pong"
```

## Clean up

```sh
for r in gitflare-spike-c-small-fork gitflare-spike-c-big-fork gitflare-spike-c-small gitflare-spike-c-big; do
  scripts/call.sh POST /artifacts/delete "{\"name\":\"$r\"}"; done
npx wrangler delete --name gitflare-spike-c-container --force
npx wrangler containers list                      # the application outlives the Worker
npx wrangler containers delete <application id>
npx wrangler containers images list               # the Dockerfile image, and every snapshot under cloudchamber-snapshots/
npx wrangler containers images delete <repository>:<tag>
```

The AI gateway and the (empty) Artifacts namespace were deleted through the REST API: `DELETE /accounts/<account-id>/ai-gateway/gateways/gitflare-spike-c-gw` and `DELETE /accounts/<account-id>/artifacts/namespaces/gitflare-spike-c-ns`.
