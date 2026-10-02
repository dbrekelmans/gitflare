# AI Gateway and Access — live observations

Observed 2026-10-02 on a live account.

Everything below was run with the code in [`spikes/gateway-access/`](../../../spikes/gateway-access/) (wrangler 4.147.0, compatibility date 2026-10-01, `jose` 6.2.12) against a gateway, two Workers, one Access application and one service token created for the test and deleted afterwards. Account-specific values are written as `<account-id>`, `<subdomain>`, `<team>`, `<aud>`. Output is verbatim but trimmed. It checks the claims in [`../ai-identity.md`](../ai-identity.md) and the Access items in [`../platform.md`](../platform.md).

**The account had no Unified Billing credits** (`GET …/ai-gateway/billing/credit-balance` → `"balance": 0, "first_topup_success": false`) and the task did not allow changing billing. Every Claude call therefore stopped at `402`. Questions 3–5 were answered with Workers AI models through the same gateway and binding; what that does and does not prove for Claude is said per question.

## What this changes

1. **Claude through the gateway needs prepaid credits or a stored key before the first call; there is no pay-as-you-go.** A fresh account gets `402` / code `2021` on every `anthropic/…` call. The installer has to check the credit balance (or store a BYOK key) and say so, and the model port needs a distinct "no credits" error. Not anticipated by the research note.
2. **The gateway caches identical requests even with `cache_ttl: 0`, across users, and a cache hit bypasses spend rules.** A second identical request returned the first one's response with `cf-aig-cache-status: HIT`, cost `0`, regardless of metadata. Agent calls must pass `skipCache: true` (or a per-request cache key) deliberately; the default is not "off".
3. **The published model schemas are enforced, per model, before billing.** `system` must be a string on every Claude model tried (no `cache_control` on the system prompt through the binding); `anthropic/claude-opus-5.5` rejects forced tool choice (`tool_choice.type` must be `auto` or `none`); `temperature` is rejected on everything but Haiku 4.5. `output_config.format` passes validation on all five models. The "forced tool call" route for structured output is therefore not portable across models on the binding; `output_config.format` is the candidate, still unproven end to end.
4. **Spend limits work as designed and are cheap to reason about.** `window` is in seconds. A breach is `429` with code `2045` and a message naming the rule; the count-based rate limit is `429` with code `2003`, so the two are distinguishable — but only by the code at the start of the thrown error's `message`, or by the body when `returnRawResponse: true`. No `Retry-After`. Enforcement lagged by one request (under 3 s); a streamed response in flight is not cut.
5. **Fixed windows are aligned to the clock, sliding windows decay.** A 60-second fixed rule cleared at the next minute boundary (39 s after the spend, not 60). A 60-second sliding rule cleared 31 s after the spend, consistent with weighting the previous window by its overlap. Neither is "N seconds after the breach".
6. **Cost is on the log almost immediately.** `getLog(env.AI.aiGatewayLogId)` returned a populated `cost` on the first read after a non-streamed call and within 0.5 s after a streamed one (first read: `Log not found`). No polling design is needed beyond one short retry.
7. **Metadata is all-or-nothing on bad values.** Six or seven entries: the first five are kept, the rest dropped silently. One `null` or object value: the whole metadata object is dropped silently — the request then matches no partitioned spend rule bucket of its own. Validate metadata in our port.
8. **Log filters on metadata are not key/value pairs.** `metadata.key = agent` AND `metadata.value = u-bob` matches a log whose `user` is `u-bob`. Make values self-describing (`user:…`, `change:…`) or filter client-side.
9. **Access in front of a Worker with static assets behaves as the note hoped.** `Cf-Access-Jwt-Assertion` reaches Worker code (with `run_worker_first` as an array and as `true`), validates with `jose` against the team JWKS, and `ctx.access` is `undefined`. Without static assets `ctx.access` is present under a hostname-based application too. The `identify(request)` port with JWT validation stands; the `ctx.access` branch is not needed.
10. **WebSocket upgrades to a Durable Object pass through Access in both shapes tried** — hostname-based (`public` destination) and Worker-level (`worker` destination) — `101` in both. The documented `403` for Worker-level applications did not occur with a service token or with the Access cookie. The research note's "protect by hostname if you use WebSockets" constraint is not supported by this test; the SSE fallback is not needed for this reason.
11. **Embedding sizes**: `bge-m3` 1024, `qwen3-embedding-0.6b` 1024, `embeddinggemma-300m` 768 (plus the documented 384/768/1024 for `bge-small/base/large`). `bge-m3` pools with `cls` by default, the `bge-*-en` models with `mean`.

## 1. Calling Claude from a Worker — `fails` on this account's billing; slugs `partial`; streaming `not tested`

**Run:** `scripts/call.sh run '{"model":"anthropic/claude-haiku-4.5","body":{"max_tokens":40,"messages":[{"role":"user","content":"Reply with the single word: pong"}]}}'` → `env.AI.run(model, body, { gateway: { id: "gitflare-spike-g-gw" } })` in [`ai/src/index.ts`](../../../spikes/gateway-access/ai/src/index.ts). Gateway created with `authentication: true`, `collect_logs: true`; the API reported `"wholesale": true, "byok_only": false`.

**Came back** (the binding throws):

```json
{"error":{"constructor":"InferenceUpstreamError","name":"AiGatewayError","message":"2021: Insufficient AI Gateway credits","ownKeys":["stack","message","name"]},"logId":null}
```

With `{ returnRawResponse: true }` the same call resolves to a `Response` instead of throwing:

```json
{"status":402,"headers":{"cf-aig-event-id":"…","cf-aig-request-id":"…","content-type":"application/json"},
 "body":"{\"success\":false,\"result\":[],\"messages\":[],\"error\":[{\"code\":2021,\"message\":\"Insufficient balance; add money to your gateway or use BYOK\"}],\"name\":\"AiGatewayError\",\"httpCode\":402,\"internalCode\":2021,…}"}
```

The thrown error carries no status and no code property: the only machine-readable part is the `NNNN:` prefix of `message`. `env.AI.aiGatewayLogId` is `null`, yet the failed request is in the gateway's logs (`provider: "anthropic"`, `status_code: 402`, `cost: 0`).

**Model slugs.** Slug and body are validated before the credit check, so an accepted slug stops at `402`/`2021` and an unknown one at `404`/`7003` (`"Model not found: anthropic/claude-haiku-4-5"`; thrown form `7003: User Input Error`).

| Accepted (`2021`) | Rejected (`7003`) |
| --- | --- |
| `anthropic/claude-haiku-4.5`, `claude-sonnet-5`, `claude-sonnet-5.5`, `claude-opus-5.5`, `claude-fable-5.1`, `claude-fable-5`, `claude-opus-5`, `claude-opus-4.8`, `claude-opus-4.7`, `claude-sonnet-4.6`, `claude-sonnet-4.5` | `anthropic/claude-haiku-4-5` (hyphen), `anthropic/claude-haiku-4-5-20251001` (Anthropic's own id), `claude-haiku-4.5` (no prefix), `anthropic/claude-haiku-5`, `anthropic/claude-3-5-haiku` |

`anthropic/claude-sonnet-5.5` is accepted and is not in the research note's table. "Accepted" means the catalog knows the slug, not that a call was served.

**The other route.** `env.AI.gateway(id).run({ provider: "anthropic", endpoint: "v1/messages", headers: { "anthropic-version": "2023-06-01" }, query: { model: "claude-haiku-4-5", … } })` returned `402` with `"Insufficient wholesale credits. Please add additional credits on the AI Gateway Cloudflare dashboard…"` and a `cf-aig-log-id` header. So it is pre-authenticated from the binding (no `401`), and it also needs credits. `getUrl("anthropic")` returned `https://gateway.ai.cloudflare.com/v1/<account-id>/gitflare-spike-g-gw/anthropic`.

**Streaming.** `stream: true` with a Claude slug: same `2021`. For a Workers AI model the binding returned a `ReadableStream` of `Uint8Array` chunks carrying SSE text (`data: {"choices":[{"delta":…`), first chunk after 14 ms. That shows the runtime return type for a model outside the typed overloads; the Anthropic event sequence itself is untested.

**Design.** Fallbacks in the note (provider-native endpoint, `gateway().run`) do not help: both draw on the same credits. The prerequisite is credits or a BYOK key under the `default` alias. Re-run `scripts/call.sh` and `scripts/validation-matrix.sh` once either exists; with credits every `402` in this section becomes a real call.

## 2. Structured output — `partial` (validation observed, behaviour `not tested`)

No Claude call was served, so whether a schema is honoured is unknown. What was observed is which request shapes the gateway lets through. **Run:** `scripts/validation-matrix.sh`. `402` = passed validation, stopped at billing; `400` = rejected with code `7003`.

| Body | haiku-4.5 | sonnet-5 | sonnet-5.5 | opus-5.5 | fable-5.1 |
| --- | --- | --- | --- | --- | --- |
| `output_config.format` = `{ type: "json_schema", schema }` | 402 | 402 | 402 | 402 | 402 |
| `output_config.format` = `"nonsense"` | 402 | 402 | 402 | 402 | 402 |
| `tools` (client-defined) | 402 | 402 | 402 | 402 | 402 |
| `tool_choice: { type: "auto" }` | 402 | 402 | 402 | 402 | 402 |
| `tool_choice: { type: "tool", name }` | 402 | 402 | 402 | **400** | 402 |
| `tool_choice: { type: "any" }` | 402 | 402 | 402 | **400** | 402 |
| `system` as an array of blocks | **400** | **400** | **400** | **400** | **400** |
| message content blocks with `cache_control` | 402 | 402 | 402 | 402 | 402 |
| `thinking: { type: "adaptive" }` | 402 | 402 | 402 | 402 | 402 |
| `temperature: 0` | 402 | **400** | **400** | **400** | **400** |

The rejections, verbatim:

```
Model execution failed (User Input Error): Invalid value at tool_choice.type: Invalid discriminator value. Expected 'auto' | 'none'
Model execution failed (User Input Error): Invalid value at system: Invalid input: expected string, received array
Model execution failed (User Input Error): Validation error at temperature: `temperature` is not supported on this model. Remove it from your request.
Model execution failed (User Input Error): Required value missing: max_tokens
```

An undeclared top-level field (`bogus_field: 1`) passes. The malformed `output_config.format` passing shows the gateway does not inspect that field; a bad schema would surface as an Anthropic error, not a gateway one.

**Design.**

- Forced tool call: not available on `claude-opus-5.5` through the binding. If a forced tool is the chosen mechanism it is per-model, which defeats the point of one port.
- `output_config.format`: not blocked anywhere — still the first candidate, still unproven.
- Instruction-plus-parse: needs nothing from the gateway; it remains the floor.
- Prompt caching of a long system prompt (`cache_control` on `system`) is not possible on the binding path. Put cacheable context in a message content block, or use the provider-native endpoint.
- Do not send `temperature`.

## 3. Cost of one request — `works` (observed on Workers AI requests through the gateway)

**Run:** `scripts/call.sh run-and-log …` — calls `env.AI.run`, reads `env.AI.aiGatewayLogId`, then polls `env.AI.gateway(id).getLog(logId)` every 250 ms.

Non-streamed, seven metadata entries sent:

```json
{"logId":"01M3YQN1N85YEFXNT0T6WEWZJ5","callMs":388,
 "usage":{"prompt_tokens":42,"completion_tokens":2,"total_tokens":44,"neurons":0.2551819682121277},
 "attempts":[{"at":0,"cost":0.0000028070016503334043,"tokens_in":42,"tokens_out":2}],
 "log":{"cost":0.0000028070016503334043,"model":"@cf/meta/llama-3.2-3b-instruct","provider":"workers-ai",
        "metadata":{"user":"u-alice","change":"c-101","agent":"review","session":"s-1","k5":"v5"},"cached":false,"status_code":200}}
```

Streamed (`stream: true`, log read after the stream was drained):

```json
{"attempts":[{"at":0,"error":"Log not found"},{"at":460,"cost":0.000007164893794804812,"tokens_in":42,"tokens_out":15}]}
```

- **Latency:** cost was present on the first `getLog` after a non-streamed call, and 460 ms after a streamed one. A ~1,100-token streamed call had its cost on the first read too.
- **Log id:** `env.AI.aiGatewayLogId` equals the `cf-aig-log-id` response header (visible with `returnRawResponse: true`). Two overlapping calls (`/concurrent`): each read of the property immediately after its own `await` returned its own id; after both, the property held the id of whichever resolved last. Reading it straight after the awaited call is safe; reading it later is not. Prefer the header when the raw response is used.
- **Metadata count:** seven sent, the first five (insertion order) kept, no error. Six sent: `a…e` kept.
- **Metadata values:** numbers and booleans are stored as such; a 600-character string is stored whole; `cf.user_id` sent by the caller is stripped. **A `null` value or a nested object makes the log's `metadata` come back `null` — every entry is lost, with no error.**
- **`cf.user_id` on binding calls:** never present on any of the ~300 logs. The note's deduction holds.
- **Filtering** (`GET …/ai-gateway/gateways/{id}/logs`, `filters` as a JSON-encoded array in the query string): `metadata.value eq u-alice` → 2 rows; `metadata.key eq change` → 2 rows; `search=c-101` → 1 row; `cost gt 0` works; combined with `cost gt 0.001` works. `metadata.key = agent` AND `metadata.value = u-bob` returned the log `{"user":"u-bob","change":"c-102","agent":"derive"}` — key and value are matched independently. `metadata.user` as a filter key is rejected (`7001: Invalid enum value`).
- **Shape:** the REST log's `metadata` is a JSON object, not a string (the research note said string; corrected there). Fields beyond the published type include `wholesale`, `byok`, `authentication`, `timings`, `usage_metadata`.
- **Cache:** see the next heading — a cache hit is logged with `cached: true`, `cost: 0`, `tokens_in: 0`.

**Caching is on with `cache_ttl: 0`.** The gateway was created with `cache_ttl: 0` (a `PUT` with `cache_ttl: null` is stored as `0`).

```
17:05:29 first call                 200 cache-status: MISS
17:05:30 same body, same user       200 cache-status: HIT
17:05:30 same body, other user      200 cache-status: HIT
17:05:30 same body, cacheTtl:0      200 cache-status: HIT
17:05:31 same body, skipCache:true  200 cache-status: MISS
17:05:31 same body again            200 cache-status: HIT
```

The same request was still a `HIT` at 17:09:15 (226 s after the first call) and a `MISS` at 17:10:33 (304 s), so the entry lives about five minutes. Metadata is not part of the cache key. Only `skipCache: true` bypassed it; `cacheTtl: 0` did not.

**Design.** Per-request and per-change cost is a read of the log by id directly after the call, with one retry for streams — no fallback (local computation from `usage`) is needed for timeliness, only as a cross-check. The metadata vocabulary must be validated by our port (≤ 5 entries, scalar non-null values). Per-change totals by log filter need unambiguous values. **Not shown for Claude:** that `cost` is populated for `anthropic/…` responses, streamed or not; the mechanism is provider-independent but the pricing lookup is not.

## 4. Spend limits — `works` (rule scoped by metadata; observed on Workers AI requests)

**Run:** rule set with `PUT /accounts/<account-id>/ai-gateway/gateways/gitflare-spike-g-gw` (all required fields plus)

```json
"spend_limits": { "enabled": true, "rules": [
  { "id": "per-user", "limitType": "cost", "limit": 0.002, "window": 3600, "technique": "fixed",
    "metadata": { "user": { "mode": "partition" } } } ] }
```

then `scripts/spend-window.sh <user> 2 45` (one ~$0.003 call, then a tiny uncached call every 2–3 s) and `scripts/spend-limit.sh`.

**What the caller receives.** With `returnRawResponse: true`:

```json
{"status":429,"headers":{"cf-aig-event-id":"…","cf-aig-log-id":"01M3YRNVFEX2F0PM3CE8T8F2FW","cf-aig-request-id":"…","cf-aig-step":"0","content-type":"application/json"},
 "body":"{\"success\":false,\"result\":[],\"messages\":[],\"error\":[{\"code\":2045,\"message\":\"Spend limit exceeded: rule 'per-user' (cost limit 0.002 per 3600s, fixed) for internal-workers-ai @cf/meta/llama-3.2-3b-instruct\"}],\"name\":\"AiGatewayError\",\"httpCode\":429,\"internalCode\":2045,…}"}
```

Without it the binding throws `AiGatewayError` with `message: "2045: Spend limit exceeded: rule 'per-user' (cost limit 0.002 per 3600s, fixed) for internal-workers-ai @cf/meta/llama-3.2-3b-instruct"`. No `Retry-After` or remaining-budget header. `stream: true` fails the same way before any stream exists. The blocked request is logged (`status_code: 429`) and has a log id.

For comparison, the gateway's count-based rate limit (`rate_limiting_limit: 3`, `rate_limiting_interval: 60`): `429`, `{"code":2003,"message":"Rate limited"}`, thrown as `2003: Rate limited`. The Unified Billing rate limit (200 requests / 60 s) was not reached.

**Unit.** `window` is seconds — the error text says `per 3600s` for `window: 3600`.

**How fast it bites.** The request that crosses the budget completes in full (a streamed 1,095-token response was not cut). The next request, sent immediately after, still passed; the one 3 s later was blocked:

```
16:56:01 big call starts   (stream, cost 0.00248 recorded at completion)
16:56:21 big call done
16:56:21 200
16:56:24 429
```

**How fast it clears.**

- `technique: "fixed"`, `window: 60`: blocked 16:56:24 → 16:56:58, `200` from 16:57:00. The window is aligned to the clock minute, so it cleared 39 s after the spend.
- `technique: "sliding"`, `window: 60`: spend of $0.00252 recorded 16:58:42, blocked 16:58:45 → 16:59:11, `200` from 16:59:13. That is where 0.00252 × (47/60) drops under 0.002: the previous window is weighted by its remaining overlap, it is not a true rolling sum.

**Scope.**

- Another `user` value: unaffected (`200`). A request with no `user` key: `200` while two users were blocked.
- The rule covers every model: an embedding call for a blocked user was also `429`.
- Counters survive a rule being re-`PUT` under the same id: a user who had overspent before the update was blocked on the first call after it.
- **Cache hits are served to a blocked user** (`200`, `cached: true`, cost `0`). My first three attempts at this test never blocked for exactly that reason: 29 of 30 calls were cache hits.
- A new rule was in force by the first check after the `PUT`, 28 s later; a rate-limit change 15 s later. Not measured more finely.

**Design.** The per-user and deployment-wide budgets work as the note assumed, and the `429` is distinguishable, so "catch the breach and downgrade in our own code" is viable without Dynamic Routing. The port has to parse the numeric prefix of the error message (or use `returnRawResponse` and read `internalCode`). A calendar-month budget is expressible only as a fixed window of N seconds aligned to the epoch, not to the month; per-change lifetime caps still have to be enforced by the forge from logged cost. **Not shown:** the same on a Unified Billing or BYOK Claude request, and anything about Dynamic Routing (needs BYOK or credits — `not tested`).

## 5. Embeddings — `works`

**Run:** `scripts/call.sh run '{"model":"@cf/baai/bge-m3","body":{"text":["decision: use hairlines not boxes","decision: one accent colour"]},"gateway":{"metadata":{"user":"u-alice","agent":"embed"}}}'`

**Came back** (vectors trimmed):

```json
{"returned":"object:Object","logId":"01M3YQN3VJW68NZT1QDD30WVT7",
 "result":{"data":[[0.0032939910888671875,-0.0259857177734375,…],[…]],"shape":[2,1024],"pooling":"cls","response":null,
           "meta":{"cost_metric_name_1":"input_tokens","cost_metric_value_1":20,"neurons":0.02149175737498028}}}
```

| Model | `shape` for one input | Other fields in the result |
| --- | --- | --- |
| `@cf/baai/bge-m3` | `[n, 1024]` | `pooling: "cls"`, `meta`, `response: null` |
| `@cf/qwen/qwen3-embedding-0.6b` | `[1, 1024]` | `usage` with `neurons` |
| `@cf/google/embeddinggemma-300m` | `[1, 768]` | none |
| `@cf/baai/bge-large-en-v1.5` | `[1, 1024]` | `pooling: "mean"`, `usage` |
| `@cf/baai/bge-base-en-v1.5` | `[1, 768]` | `pooling: "mean"`, `usage` |
| `@cf/baai/bge-small-en-v1.5` | `[1, 384]` | `pooling: "mean"`, `usage` |

Request shape `{ text: string[] }` worked for all six. The gateway logs each call with a cost (`2.2e-7` for the two-sentence `bge-m3` call) and the metadata; `tokens_in` is `0` on the `bge-m3` log although the result reports 20 input tokens. Embedding calls are subject to spend rules (section 4).

**Design.** The "no vector database" plan stands. Read the dimension from `shape` and store `pooling` with the vectors — the default differs between `bge-m3` (`cls`) and the English `bge` models (`mean`). Embedding spend is visible per user in the same logs as model spend.

## 6. Access in front of an app Worker — `works`

**Run:** [`app/`](../../../spikes/gateway-access/app/) — a Worker with static assets (`not_found_handling: "single-page-application"`, `run_worker_first: ["/api/*", "/ws/*"]`), `/api/whoami`, and `/ws/*` forwarded to a Durable Object using the hibernation API. Access application created with

```json
{ "type": "self_hosted", "name": "gitflare-spike-g-app", "session_duration": "1h",
  "destinations": [{ "type": "public", "uri": "gitflare-spike-g-app.<subdomain>.workers.dev" }],
  "policies": [
    { "name": "gitflare-spike-g-svc", "decision": "non_identity", "include": [{ "service_token": { "token_id": "<id>" } }] },
    { "name": "gitflare-spike-g-people", "decision": "allow", "include": [{ "email_domain": { "domain": "example.com" } }] } ] }
```

and called with `scripts/access.sh`. A hostname application on a `workers.dev` hostname needs no zone.

**Service token, `GET /api/whoami`:**

```json
{"headerNames":["accept","accept-encoding","cf-access-jwt-assertion","cf-connecting-ip","cf-ipcountry","cf-ray","cf-visitor","connection","cookie","host","user-agent","x-forwarded-proto","x-real-ip"],
 "jwtHeaderPresent":true,"cfAuthorizationCookiePresent":true,"clientSecretHeaderReachedWorker":false,
 "ctxAccess":"undefined","ctxKeys":["tracing","access","cache","props","exports"],
 "jwtProtectedHeader":{"typ":"JWT","alg":"RS256","kid":"…"},
 "jwtClaimsUnverified":{"type":"app","iat":1790960420,"exp":1790964021,"iss":"https://<team>.cloudflareaccess.com","sub":"","aud":"<aud>","common_name":"<client-id>.access","h_INTERNAL_DO_NOT_USE":"gitflare-spike-g-app.<subdomain>.workers.dev"},
 "joseVerify":{"ok":true,"ms":48,"claimNames":["aud","common_name","exp","h_INTERNAL_DO_NOT_USE","iat","iss","sub","type"]},
 "joseVerifyWrongAud":"JWTClaimValidationFailed: unexpected \"aud\" claim value"}
```

- **The JWT header reaches Worker code** and `jwtVerify(token, createRemoteJWKSet(<team>/cdn-cgi/access/certs), { issuer, audience })` succeeds (40–90 ms including the JWKS fetch). The JWKS has two RS256 keys. `aud` in the token is a string here, not the array the docs show; `jose` accepts both.
- The `CF-Access-Client-Id` / `-Secret` headers are stripped before the Worker; a `CF_Authorization` cookie is injected into the request and set on the response.
- A client-supplied `Cf-Access-Jwt-Assertion: bogus` sent alongside valid credentials is overwritten — the Worker saw Access's token. The same header with no credentials never reaches the Worker.
- A service-token identity is `sub: ""` plus `common_name`, as documented. `exp − iat` was 3601 s, following `session_duration: "1h"`.
- Static assets and the SPA fallback are served behind Access (`GET /` and `GET /some/spa/route` → `200 text/html`).

**`ctx.access`:**

| Worker | Destination | `ctx.access` | `getIdentity()` |
| --- | --- | --- | --- |
| static assets, `run_worker_first: ["/api/*","/ws/*"]` | hostname (`public`) | `undefined` | — |
| static assets, `run_worker_first: true` | hostname | `undefined` | — |
| static assets, array form | Worker-level (`worker`) | `undefined` | — |
| no static assets | Worker-level | object, `aud` equals the application's | `undefined` (service token) |
| no static assets | hostname | object, `aud` equals the application's | `undefined` (service token) |

The key `access` exists on `ctx` in every case; with static assets its value is `undefined`.

**WebSocket upgrade to the Durable Object** (raw upgrade with `curl --http1.1`; the object's first frame echoes what the Worker saw):

```
HTTP/1.1 101 Switching Protocols
Upgrade: websocket
{"hello":"from Room","seenByWorker":{"jwtHeaderPresent":true,"joseVerify":{"ok":true,…},"ctxAccess":"undefined"}}
```

`101` with the service token under the hostname destination, and `101` with the service token and with the cookie alone under the Worker-level destination (`destinations: [{ "type": "worker", "worker_id": "<32-hex id from GET /accounts/<account-id>/workers/workers>" }]`), with and without static assets. The JWT header is on the upgrade request, so the Worker can authenticate the socket before handing it to the object.

**Unauthenticated:**

| Request | Application has only the service-token policy | Application also has an `allow` policy |
| --- | --- | --- |
| `GET /`, `GET /api/whoami` | `403`, HTML error page (JSON body with `Accept: application/json`), headers `cf-access-aud`, `cf-access-domain` | `302` to `https://<team>.cloudflareaccess.com/cdn-cgi/access/login/<host>?kid=<aud>&meta=…&redirect_url=…`, sets `CF_AppSession` |
| same with `X-Requested-With: XMLHttpRequest` | not run | `401`, HTML body |
| WebSocket upgrade | `403` | `302` |
| wrong service-token secret | `403` | `302` |

`Accept: application/json` and `Sec-Fetch-Mode: cors` do not change the `302`. Both the `302` and the `401` carry `www-authenticate: Cloudflare-Access resource_metadata="https://<host>/.well-known/cloudflare-access-protected-resource/<path>"` although Managed OAuth was not enabled; that document answered `200` with `authorization_servers: ["https://<team>.cloudflareaccess.com"]` and one `authentication_methods` entry (`cloudflared`). `https://<team>.cloudflareaccess.com/.well-known/oauth-authorization-server` exists and matches the note's quoted document except that `issuer` includes `https://` and there is no `registration_endpoint`.

**The Access cookie on its own.** After a service-token request, replaying only the `CF_Authorization` cookie was `403` while the application had just the service-token policy, and `200` (HTTP and WebSocket) once the `allow` policy had been added. The two runs differ in both policy set and time, so the cause is not isolated.

**Design.** Validate `Cf-Access-Jwt-Assertion` with `jose` everywhere; do not branch on `ctx.access`. The SPA's `fetch` calls get an opaque cross-origin `302` when the session lapses unless they send `X-Requested-With: XMLHttpRequest`, which turns it into a `401` the client can act on. Live status over a Durable Object WebSocket works behind either destination type, so the single `worker` destination (which also covers previews and custom domains) remains usable — contrary to the docs. Re-test before relying on it, since it contradicts a documented limitation.

**Untested, because a human login cannot be driven from here:**

- A browser session: the claims of a user token (`email`, a non-empty `sub`, `identity_nonce`), `getIdentity()` returning an identity, and whether `user_uuid` equals `sub`.
- A browser WebSocket (cookie from an interactive login, `Origin` header) through either destination type — the `101` above is from `curl` with a service token or a service-token cookie.
- Who can log in under an email-domain policy on this organisation (it has the `cloudflare` and `onetimepin` identity providers; a fresh one may not).
- Managed OAuth (`gitflare login`): not enabled, no token minted. Only the discovery documents were fetched.
- `access.dev` locally, and `cf.user_id` through an Access-protected gateway custom domain (needs a zone).

## Spend and cleanup

- Model spend: $0.0114 of Workers AI usage by the gateway's own cost figures (300 logged requests, 56 of them cache hits and 59 of them refused Claude calls at $0, about 1,100 neurons — inside the daily free allocation if it applies). Claude: $0, no call was served. Workers, Durable Object and Access usage: a few hundred requests. Estimated total: under $0.02 of the $3 limit.
- Created and deleted: gateway `gitflare-spike-g-gw`, Workers `gitflare-spike-g-ai` and `gitflare-spike-g-app` (with its Durable Object namespace), Access application `gitflare-spike-g-app` (its two policies were inline), service token `gitflare-spike-g-token`. Nothing else in the account was changed.
