# Spike: Claude through AI Gateway, cost and limits, Access in front of a Worker

Throwaway code behind [`spec/research/live/gateway-access.md`](../../spec/research/live/gateway-access.md). It creates real resources and spends real (small) money: run it only on an account where that has been authorised, and delete everything afterwards (last section).

- `ai/` — Worker `gitflare-spike-g-ai`: a generic executor over the `AI` binding (`/run`, `/run-and-log`, `/log`, `/gateway-run`, `/concurrent`, `/url`), guarded by a shared secret.
- `app/` — Worker `gitflare-spike-g-app`: static assets, `/api/whoami`, and `/ws/*` to a Durable Object, to sit behind Access.
- `scripts/` — the calls that were made.

Needs: `wrangler@4.147.0` logged in (`npx wrangler@4.147.0 whoami`), `curl`, `python3`, and a Cloudflare API token (or the Cloudflare MCP tools) with **AI Gateway Write** and **Access: Apps and Policies Write** + **Access: Service Tokens Write** — wrangler's own login has neither. Below, `$CF_API` is `https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID` and `$AUTH` is `Authorization: Bearer $CLOUDFLARE_API_TOKEN`. Keep both, and everything minted below, out of git.

## 1. Gateway and AI Worker (questions 1–5)

```sh
curl "$CF_API/ai-gateway/gateways" -H "$AUTH" --json '{
  "id": "gitflare-spike-g-gw", "authentication": true, "collect_logs": true,
  "cache_invalidate_on_update": true, "cache_ttl": 0, "rate_limiting_interval": 0, "rate_limiting_limit": 0 }'

cd ai
npx wrangler@4.147.0 deploy
openssl rand -hex 24 | tee /dev/stderr | npx wrangler@4.147.0 secret put SPIKE_KEY   # note the value printed
cd ..
export SPIKE_URL=https://gitflare-spike-g-ai.<subdomain>.workers.dev SPIKE_KEY=<that value>
```

Question 1 and 2 (Claude; costs nothing without Unified Billing credits, a few cents with):

```sh
scripts/call.sh run '{"model":"anthropic/claude-haiku-4.5","body":{"max_tokens":40,"messages":[{"role":"user","content":"Reply with the single word: pong"}]}}'
scripts/call.sh run '{"model":"anthropic/claude-haiku-4.5","body":{"max_tokens":40,"stream":true,"messages":[{"role":"user","content":"pong"}]}}'
scripts/call.sh run '{"model":"anthropic/claude-haiku-4.5","body":{"max_tokens":16,"messages":[{"role":"user","content":"pong"}]},"options":{"returnRawResponse":true}}'
scripts/call.sh gateway-run '{"provider":"anthropic","endpoint":"v1/messages","headers":{"anthropic-version":"2023-06-01","content-type":"application/json"},"query":{"model":"claude-haiku-4-5","max_tokens":16,"messages":[{"role":"user","content":"pong"}]}}'
bash scripts/validation-matrix.sh            # which body fields each model's validation accepts
```

Question 3 and 5 (Workers AI through the gateway, fractions of a cent):

```sh
scripts/call.sh run-and-log '{"model":"@cf/meta/llama-3.2-3b-instruct","body":{"max_tokens":40,"messages":[{"role":"user","content":"Reply with the single word: pong"}]},"gateway":{"skipCache":true,"metadata":{"user":"u-alice","change":"c-101","agent":"review","session":"s-1","k5":"v5","k6":"v6","k7":"v7"}},"waitMs":20000}'
scripts/call.sh run-and-log '{"model":"@cf/meta/llama-3.2-3b-instruct","body":{"max_tokens":40,"stream":true,"messages":[{"role":"user","content":"Count from 1 to 5"}]},"gateway":{"skipCache":true,"metadata":{"user":"u-bob","change":"c-102","agent":"derive"}},"waitMs":20000}'
scripts/call.sh concurrent '{"model":"@cf/meta/llama-3.2-3b-instruct"}'
scripts/call.sh run '{"model":"@cf/baai/bge-m3","body":{"text":["decision: use hairlines not boxes","decision: one accent colour"]},"gateway":{"metadata":{"user":"u-alice","agent":"embed"}}}'
curl -G "$CF_API/ai-gateway/gateways/gitflare-spike-g-gw/logs" -H "$AUTH" \
  --data-urlencode 'filters=[{"key":"metadata.value","operator":"eq","value":["u-alice"]}]'
```

Leave `skipCache` out of a repeated call to see the cache: the response header `cf-aig-cache-status` (with `"options":{"returnRawResponse":true}`) goes from `MISS` to `HIT`.

Question 4 (about $0.003 per `spend-window.sh` run). `PUT` replaces the gateway config, so send the required fields again:

```sh
curl -X PUT "$CF_API/ai-gateway/gateways/gitflare-spike-g-gw" -H "$AUTH" --json '{
  "authentication": true, "collect_logs": true, "cache_invalidate_on_update": true, "cache_ttl": 0,
  "rate_limiting_interval": 0, "rate_limiting_limit": 0,
  "spend_limits": { "enabled": true, "rules": [
    { "id": "fixed60", "limitType": "cost", "limit": 0.002, "window": 60, "technique": "fixed",
      "metadata": { "user": { "mode": "partition" } } } ] } }'
bash scripts/spend-window.sh u-hank 2 45     # one ~$0.003 call, then a status every ~2 s
bash scripts/spend-limit.sh u-dave 1         # another user is not blocked
```

Repeat with `"technique": "sliding"`, and with `"rate_limiting_limit": 3, "rate_limiting_interval": 60` (no spend rules) plus `bash scripts/spend-limit.sh u-rl 6 1` for the rate-limit response.

## 2. Access in front of the app Worker (question 6)

```sh
curl "$CF_API/access/service_tokens" -H "$AUTH" --json '{ "name": "gitflare-spike-g-token", "duration": "3h" }'
#   -> id, client_id, client_secret (shown once)
curl "$CF_API/access/apps" -H "$AUTH" --json '{
  "type": "self_hosted", "name": "gitflare-spike-g-app", "session_duration": "1h",
  "destinations": [{ "type": "public", "uri": "gitflare-spike-g-app.<subdomain>.workers.dev" }],
  "policies": [
    { "name": "gitflare-spike-g-svc", "decision": "non_identity", "include": [{ "service_token": { "token_id": "<service token id>" } }] },
    { "name": "gitflare-spike-g-people", "decision": "allow", "include": [{ "email_domain": { "domain": "example.com" } }] } ] }'
#   -> id, aud
curl "$CF_API/access/organizations" -H "$AUTH"      # -> auth_domain = <team>.cloudflareaccess.com

cd app
npm install
npx wrangler@4.147.0 deploy
printf 'https://<team>.cloudflareaccess.com' | npx wrangler@4.147.0 secret put TEAM_DOMAIN
printf '<aud>' | npx wrangler@4.147.0 secret put POLICY_AUD
cd ..
export APP_URL=https://gitflare-spike-g-app.<subdomain>.workers.dev CF_ACCESS_CLIENT_ID=… CF_ACCESS_CLIENT_SECRET=…
bash scripts/access.sh
```

Create the Access application before the first deploy so the Worker is never public. Variants that were run:

- Without static assets (`ctx.access` appears): `npx wrangler@4.147.0 deploy -c wrangler.noassets.jsonc`.
- `run_worker_first: true`: edit `app/wrangler.jsonc` accordingly and deploy.
- Worker-level destination: `PUT $CF_API/access/apps/<app id>` with the same body but `"destinations": [{ "type": "worker", "worker_id": "<id>" }]`, where `<id>` is the `id` of the Worker in `GET $CF_API/workers/workers`. Wait ~20 s before re-running `scripts/access.sh`.
- Service-token policy only: leave out the second policy; unauthenticated requests then get `403` instead of `302`.

## 3. Clean up

```sh
curl -X DELETE "$CF_API/access/apps/<app id>" -H "$AUTH"
curl -X DELETE "$CF_API/access/service_tokens/<service token id>" -H "$AUTH"
curl -X DELETE "$CF_API/ai-gateway/gateways/gitflare-spike-g-gw" -H "$AUTH"
npx wrangler@4.147.0 delete --name gitflare-spike-g-app --force
npx wrangler@4.147.0 delete --name gitflare-spike-g-ai --force
```

The live run used the Cloudflare MCP tools for the `$CF_API` calls instead of `curl` with a token; the request bodies are the ones shown here.
