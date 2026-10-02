# AI Gateway and Access — live observations

Observed 2026-10-02 on a live account.

Everything below was run with the code in [`spikes/gateway-access/`](../../../spikes/gateway-access/) (wrangler 4.147.0, compatibility date 2026-10-01, `jose` 6.2.12) against a gateway, two Workers, one Access application and one service token created for the test and deleted afterwards. There were two sessions on the same day: 16:34–17:11 UTC, and 18:19–18:37 UTC (resources re-created to run the scripts end to end, add controls, and repeat the timing measurements). Account-specific values are written as `<account-id>`, `<subdomain>`, `<team>`, `<aud>`. Output is verbatim but trimmed. It checks the claims in [`../ai-identity.md`](../ai-identity.md) and the Access items in [`../platform.md`](../platform.md).

**How to read the strength of a statement.** Each observation says how many times it was seen. "Observed" means exactly that, on this one account, on this day. Where a design consequence goes beyond the observation it is marked _inference_.

**The account had no Unified Billing credits** (`GET …/ai-gateway/billing/credit-balance` → `"balance": 0, "first_topup_success": false`) and no stored provider key on the test gateway, and the task did not allow changing billing. Every Claude call therefore stopped at `402`. Questions 3–5 were answered with Workers AI models through the same gateway and binding; **nothing in sections 3–5 was observed on a Claude request**, and each section says what that leaves open.

## What this changes

1. **On this account, Claude through the gateway was refused for lack of credits.** With a balance of 0 and no stored key, all 76 `anthropic/…` calls returned `402` / code `2021`. _Inference:_ the installer should check the credit balance (or store a BYOK key) and the model port needs a distinct "no credits" error. Not observed: an account with credits, auto top-up, or a stored key — so this does not show what the minimum working setup is, only that this one is not it.
2. **The gateway served identical Workers AI requests from cache although it was created with `cache_ttl: 0`.** Hits were shared across different metadata (users), cost `0`, were served to a caller who was over a spend limit, and lasted about 300 s (bracketed twice: HIT at 226 s / MISS at 304 s; HIT at 296 s / MISS at 306 s). `skipCache: true` avoided it; `cacheTtl: 0` did not. _Inference:_ until a Claude request is tested, assume the same applies and pass `skipCache: true` (or a per-request cache key) deliberately.
3. **The published model schemas are enforced, per model, before billing** (observed for five Claude slugs, same result in both sessions for the cases repeated). `system` must be a string; `anthropic/claude-opus-5.5` rejects `tool_choice` of type `tool` and `any`; `temperature` is rejected on everything but Haiku 4.5. `output_config.format` passes validation on all five. So forced tool choice is not portable across models on the binding path. Whether Claude then honours `output_config.format` was not observed.
4. **A breached spend rule returns `429` with code `2045`; the rate limit returns `429` with code `2003`.** `window` is in seconds. No `Retry-After`. The codes are reachable only as the numeric prefix of the thrown error's `message`, or in the body with `returnRawResponse: true`.
5. **Spend-rule timing, from 9 overspends:** in 8, the first request after the overspend passed and the next (2–3 s later) was blocked; **in 1, nothing was blocked at all** although the cost was logged (cause not found). A streamed response in flight was never cut. Fixed 60-second rules cleared at the next clock-minute boundary (3 of 3); sliding 60-second rules cleared when the previous minute's spend, weighted by its overlap, fell under the limit (2 of 2). _Inference:_ spend rules are a backstop, not an exact cap.
6. **Cost was on the log by the time it was read.** Of 14 `getLog` reads straight after a call, 13 had `cost` on the first read; one (streamed) said `Log not found` and had it 460 ms later. All Workers AI.
7. **Metadata is all-or-nothing on bad values** (2 of 2 sessions). More than five entries: the first five are kept. One `null` or object value: the log's `metadata` is `null` — every entry is lost, with no error.
8. **Log filters on metadata key and value are not paired.** `metadata.key = agent` AND `metadata.value = u-bob` matched a log whose `user` is `u-bob` (2 of 2 sessions).
9. **Access in front of a Worker with static assets:** `Cf-Access-Jwt-Assertion` reached Worker code and validated with `jose` in every configuration tried; `ctx.access` was `undefined` with static assets and present without them. _Inference:_ the `identify(request)` port with JWT validation stands and need not branch on `ctx.access`.
10. **A WebSocket upgrade to a Durable Object returned `101` behind a hostname-based application and behind a Worker-level one**, with a service token (4 runs under the Worker-level destination, each with a control showing the application was enforcing). The docs say Worker-level applications answer `403`. This was not tested with a browser session, so it does **not** retire the note's "protect by hostname or use SSE" fallback; it means the documented limitation could not be reproduced with a service token. Keep the fallback until a browser login is tested.
11. **Embedding sizes** (one call each): `bge-m3` 1024, `qwen3-embedding-0.6b` 1024, `embeddinggemma-300m` 768, `bge-small/base/large-en-v1.5` 384/768/1024. `bge-m3` returned `pooling: "cls"`, the English `bge` models `pooling: "mean"`.

## 1. Calling Claude from a Worker — `fails` on this account's billing; slugs `partial`; streaming `not tested`

**Run:** `scripts/call.sh run '{"model":"anthropic/claude-haiku-4.5","body":{"max_tokens":40,"messages":[{"role":"user","content":"Reply with the single word: pong"}]}}'` → `env.AI.run(model, body, { gateway: { id: "gitflare-spike-g-gw" } })` in [`ai/src/index.ts`](../../../spikes/gateway-access/ai/src/index.ts). Gateway created with `authentication: true`, `collect_logs: true`; the API reported `"wholesale": true, "byok_only": false`. Then `scripts/slugs.sh`.

**Came back** (the binding throws):

```json
{"op":"run","ms":89,"error":{"thrown":true,"constructor":"InferenceUpstreamError","name":"AiGatewayError","message":"2021: Insufficient AI Gateway credits","ownKeys":["stack","message","name"],"extra":{"name":"AiGatewayError"}},"logId":null}
```

With `{ returnRawResponse: true }` the same call resolves to a `Response` instead of throwing:

```json
{"status":402,"headers":{"cf-aig-event-id":"…","cf-aig-request-id":"…","content-type":"application/json"},
 "body":"{\"success\":false,\"result\":[],\"messages\":[],\"error\":[{\"code\":2021,\"message\":\"Insufficient balance; add money to your gateway or use BYOK\"}],\"name\":\"AiGatewayError\",\"httpCode\":402,\"internalCode\":2021,…}"}
```

The thrown error has no status or code property: the only machine-readable part is the `NNNN:` prefix of `message`. `env.AI.aiGatewayLogId` is `null`, yet the refused request is in the gateway's logs (`provider: "anthropic"`, `status_code: 402`, `cost: 0`).

**Model slugs and pre-billing validation** — `scripts/slugs.sh`, second session, verbatim:

```
### slugs
anthropic/claude-haiku-4.5                   402 2021 Insufficient balance; add money to your gateway or use BYOK
anthropic/claude-sonnet-5                    402 2021 Insufficient balance; add money to your gateway or use BYOK
anthropic/claude-sonnet-5.5                  402 2021 Insufficient balance; add money to your gateway or use BYOK
anthropic/claude-opus-5.5                    402 2021 Insufficient balance; add money to your gateway or use BYOK
anthropic/claude-fable-5.1                   402 2021 Insufficient balance; add money to your gateway or use BYOK
anthropic/claude-fable-5                     402 2021 Insufficient balance; add money to your gateway or use BYOK
anthropic/claude-opus-5                      402 2021 Insufficient balance; add money to your gateway or use BYOK
anthropic/claude-opus-4.8                    402 2021 Insufficient balance; add money to your gateway or use BYOK
anthropic/claude-opus-4.7                    402 2021 Insufficient balance; add money to your gateway or use BYOK
anthropic/claude-opus-4.6                    402 2021 Insufficient balance; add money to your gateway or use BYOK
anthropic/claude-opus-4.5                    402 2021 Insufficient balance; add money to your gateway or use BYOK
anthropic/claude-sonnet-4.6                  402 2021 Insufficient balance; add money to your gateway or use BYOK
anthropic/claude-sonnet-4.5                  402 2021 Insufficient balance; add money to your gateway or use BYOK
anthropic/claude-haiku-4-5                   404 7003 Model not found: anthropic/claude-haiku-4-5
anthropic/claude-haiku-4-5-20251001          404 7003 Model not found: anthropic/claude-haiku-4-5-20251001
claude-haiku-4.5                             404 7003 Model not found: claude-haiku-4.5
anthropic/claude-haiku-5                     404 7003 Model not found: anthropic/claude-haiku-5
anthropic/claude-3-5-haiku                   404 7003 Model not found: anthropic/claude-3-5-haiku
anthropic/claude-does-not-exist              404 7003 Model not found: anthropic/claude-does-not-exist
### body cases (anthropic/claude-haiku-4.5)
valid                                        402 2021 Insufficient balance; add money to your gateway or use BYOK
no max_tokens                                400 7003 Model execution failed (User Input Error): Required value missing: max_tokens
messages not an array                        400 7003 Model execution failed (User Input Error): Invalid value at messages: Invalid input: expected array, received string
unknown top-level field                      402 2021 Insufficient balance; add money to your gateway or use BYOK
system as number                             400 7003 Model execution failed (User Input Error): Invalid value at system: Invalid input: expected string, received number
stream: true                                 402 2021 Insufficient balance; add money to your gateway or use BYOK
```

The thrown form of a rejection is only `7003: User Input Error` — the detail ("Model not found", the field name) is in the raw body, not in the thrown message.

What this shows: the 13 dotted `anthropic/claude-…` slugs get past the model lookup and the six malformed ones do not; slug and body are checked before the credit check. What it does not show: that any of the 13 can actually be served. `anthropic/claude-sonnet-5.5` is not in the research note's table.

**The other route.** `scripts/call.sh gateway-run '{"provider":"anthropic","endpoint":"v1/messages","headers":{"anthropic-version":"2023-06-01","content-type":"application/json"},"query":{"model":"claude-haiku-4-5","max_tokens":16,"messages":[…]}}'` → `env.AI.gateway(id).run(…)`, one call:

```json
{"returned":"Response","logId":null,"response":{"status":402,"headers":{"cf-aig-log-id":"01M3YQKKR8MKYW26A1PWBGGB4X","cf-aig-step":"0",…},
 "body":"{…\"error\":[{\"code\":2021,\"message\":\"Insufficient wholesale credits. Please add additional credits on the AI Gateway Cloudflare dashboard to continue using provider models.\"}],…}"}}
```

It was refused for credits, not for authentication, on a gateway with `authentication: true` and no token supplied. That is consistent with the binding pre-authenticating this route, but a served request is the proof and there was none. `getUrl("anthropic")` returned `https://gateway.ai.cloudflare.com/v1/<account-id>/gitflare-spike-g-gw/anthropic`.

**Streaming.** `stream: true` with a Claude slug: `2021`, like everything else. For a Workers AI model the binding returned a `ReadableStream` of `Uint8Array` chunks carrying SSE text (`data: {"choices":[{"delta":…`), first chunk after 14 ms. The Anthropic event sequence is untested.

**Design.** The fallbacks in the research note (provider-native endpoint, `gateway().run`) were refused the same way, so they are not a way around missing credits. Re-run `scripts/slugs.sh` and `scripts/validation-matrix.sh` once the account has credits or a stored key; every `402` in this section then becomes a real call.

## 2. Structured output — `partial` (validation observed, behaviour `not tested`)

No Claude call was served, so whether a schema is honoured is unknown. What was observed is which request shapes pass the gateway's validation. **Run:** `scripts/validation-matrix.sh` (once, first session). `402` = passed validation and stopped at billing; `400` = rejected with code `7003`.

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
```

A `402` means only "not rejected before billing". The malformed `output_config.format` passing shows the gateway does not inspect that field, so a `402` on the well-formed one says nothing about Anthropic accepting it.

**Design.**

- Forced tool call: rejected on `claude-opus-5.5` through the binding, so it cannot be the one mechanism for all models.
- `output_config.format`: not rejected by the gateway on any of the five — still the first candidate, still unproven.
- Instruction-plus-parse needs nothing from the gateway; it remains the floor.
- `cache_control` on the system prompt is not expressible on the binding path (`system` must be a string). A message content block carrying `cache_control` is not rejected by validation; whether prompt caching then takes effect was not observed.
- Do not send `temperature` to any model but Haiku 4.5.

## 3. Cost of one request — `works` for Workers AI requests through the gateway; `not tested` for Claude

**Run:** `scripts/call.sh run-and-log …` — calls `env.AI.run`, reads `env.AI.aiGatewayLogId`, then polls `env.AI.gateway(id).getLog(logId)` every 250 ms.

Non-streamed, seven metadata entries sent:

```json
{"logId":"01M3YQN1N85YEFXNT0T6WEWZJ5","callMs":388,
 "usage":{"prompt_tokens":42,"completion_tokens":2,"total_tokens":44,"neurons":0.2551819682121277},
 "attempts":[{"at":0,"cost":0.0000028070016503334043,"tokens_in":42,"tokens_out":2}],
 "log":{"cost":0.0000028070016503334043,"model":"@cf/meta/llama-3.2-3b-instruct","provider":"workers-ai",
        "metadata":{"user":"u-alice","change":"c-101","agent":"review","session":"s-1","k5":"v5"},"cached":false,"status_code":200}}
```

Streamed (`stream: true`, log read after the stream was drained), first session:

```json
{"attempts":[{"at":0,"error":"Log not found"},{"at":460,"cost":0.000007164893794804812,"tokens_in":42,"tokens_out":15}]}
```

- **Latency.** 14 reads immediately after a call: 4 non-streamed and 10 streamed (two small, eight of ~1,000–1,300 output tokens). 13 had `cost` on the first `getLog`; the one above did not and had it at 460 ms. Small sample, one model family; treat "one short retry" as the design, not "always immediate".
- **Log id.** `env.AI.aiGatewayLogId` equalled the `cf-aig-log-id` response header. `scripts/call.sh concurrent …` (two overlapping calls, once):

  ```json
  {"results":[{"tag":"slow","header":"01M3YS81Y46QBWXC38KNX7TBFQ","property":"01M3YS81Y46QBWXC38KNX7TBFQ","propertyAfterBody":"01M3YS81Y46QBWXC38KNX7TBFQ"},
              {"tag":"fast","header":"01M3YS81YBVPG7J0J44KT3YWHZ","property":"01M3YS81YBVPG7J0J44KT3YWHZ","propertyAfterBody":"01M3YS81YBVPG7J0J44KT3YWHZ"}],
   "logs":[{"tag":"slow","headerLogMetadata":{"tag":"slow"}},{"tag":"fast","headerLogMetadata":{"tag":"fast"}}],"propertyAtEnd":"01M3YS81Y46QBWXC38KNX7TBFQ"}
  ```

  Each read of the property right after its own `await` gave its own id; afterwards it held the id of the call that resolved last. One run does not prove the property is race-free; the header on the raw response is the unambiguous source.
- **Metadata** — `scripts/metadata.sh`, second session, verbatim (the first session gave the same results for the cases it covered):

  ```
  string values                  log.metadata = {"user": "u-alice", "agent": "review"}
  number + boolean               log.metadata = {"user": 12345, "flag": true}
  null value                     log.metadata = null
  nested object                  log.metadata = null
  reserved cf.user_id            log.metadata = {"user": "u"}
  600-character value            log.metadata = {"long": "<string of 600>", "user": "u"}
  6 entries                      log.metadata = {"a": "1", "b": "2", "c": "3", "d": "4", "e": "5"}
  7 entries                      log.metadata = {"user": "u-alice", "change": "c-101", "agent": "review", "session": "s-1", "k5": "v5"}
  ```

  The `null` and nested-object cases were sent as `{"user":"u","nothing":null}` and `{"obj":{"a":1},"user":"u"}`: the valid `user` entry is lost with them. None of the calls errored.
- **`cf.user_id` on binding calls:** no log had a metadata key starting `cf.` (checked by listing every log at the end of each session: 299 and 213). The research note's deduction holds for this setup (no gateway custom domain).
- **Filtering** — `GET …/ai-gateway/gateways/{id}/logs` with `filters` as a JSON-encoded array in the query string (made through the Cloudflare MCP tool; `scripts/log-filters.sh` is the same requests as `curl`). Second session, result count and the metadata of the first two rows:

  ```
  metadata.value eq u-alice -> 2 rows [{"user":"u-alice","change":"c-101","agent":"review","session":"s-1","k5":"v5"},{"user":"u-alice","agent":"review"}]
  metadata.key eq change -> 2 rows [{"user":"u-bob","change":"c-102","agent":"derive"},{"user":"u-alice","change":"c-101","agent":"review","session":"s-1","k5":"v5"}]
  key=user AND value=u-bob -> 1 rows [{"user":"u-bob","change":"c-102","agent":"derive"}]
  key=agent AND value=u-bob (not a real pair) -> 1 rows [{"user":"u-bob","change":"c-102","agent":"derive"}]
  key=session AND value=u-bob (u-bob log has no session key) -> 0 rows []
  metadata.user eq u-bob (invalid key) -> Error: Cloudflare API error: 7001: Invalid enum value. Expected 'id' | 'created_at' | …
  value=u-in1 AND cost gt 0.001 -> 1 rows [{"user":"u-in1"}]
  search=c-102 -> 1 rows [{"user":"u-bob","change":"c-102","agent":"derive"}]
  ```

  So a key filter and a value filter each have to match some entry of the log, not the same entry.
- **Shape.** The REST log's `metadata` is a JSON object (`typeof` → `object`), not a string as the API reference types it (corrected in the research note). A row, trimmed: `{"id":"01M3YXR4DDEG62VJ46GSK2V1B6","provider":"workers-ai","model":"@cf/meta/llama-3.2-3b-instruct","status_code":200,"cost":0.000006829671315848827,"tokens_in":42,"tokens_out":14,"cached":false,"metadata":{"user":"u-bob","change":"c-102","agent":"derive"}}`. Fields beyond the published binding type include `wholesale`, `byok`, `authentication`, `timings`, `usage_metadata`.

**Caching with `cache_ttl: 0`.** The gateway was created with `cache_ttl: 0` (a `PUT` with `cache_ttl: null` is stored as `0`). First session, one prompt, `cf-aig-cache-status` from the raw response:

```
17:05:29 first call                 200 cache-status: MISS
17:05:30 same body, same user       200 cache-status: HIT
17:05:30 same body, other user      200 cache-status: HIT
17:05:30 same body, cacheTtl:0      200 cache-status: HIT
17:05:31 same body, skipCache:true  200 cache-status: MISS
17:05:31 same body again            200 cache-status: HIT
17:09:15 recheck                    200 cache-status: HIT     (226 s)
17:10:33 recheck                    200 cache-status: MISS    (304 s)
```

Second session, a fresh gateway and prompt, polled every ~9 s around the five-minute mark:

```
18:20:20 first call                 200 cache-status: MISS
18:20:20 same body, other user      200 cache-status: HIT
18:24:03 … 18:25:16 (9 polls)       200 cache-status: HIT     (last HIT at 296 s)
18:25:26                            200 cache-status: MISS    (306 s)
18:25:35 … 18:26:03 (4 polls)       200 cache-status: HIT     (re-stored by the miss)
```

A gateway `PUT` at 18:24:17 (with `cache_invalidate_on_update: true`) did not evict the entry. A hit is logged with `cached: true`, `cost: 0`, `tokens_in: 0`. In the first session this went unnoticed at first: 29 of 30 calls in an early spend test were cache hits.

**Design.** Per-request and per-change cost is a read of the log by id directly after the call, with one retry — computing from `usage` locally is a cross-check, not a necessity. Our port must validate metadata (≤ 5 entries, scalar non-null values) because the gateway silently discards instead of rejecting. Per-change totals by log filter need values that are unambiguous on their own (`user:…`, `change:…`) or client-side filtering. _Inference, not observed:_ that `cost` is populated the same way for `anthropic/…` responses, and that Claude requests are cached the same way — the mechanisms look provider-independent, but no Claude request reached them.

## 4. Spend limits — `works`, with one unexplained miss (Workers AI requests; `not tested` for Claude)

**Run:** rule set with `PUT /accounts/<account-id>/ai-gateway/gateways/gitflare-spike-g-gw` (all required fields plus)

```json
"spend_limits": { "enabled": true, "rules": [
  { "id": "per-user", "limitType": "cost", "limit": 0.002, "window": 3600, "technique": "fixed",
    "metadata": { "user": { "mode": "partition" } } } ] }
```

then `scripts/spend-window.sh <user> 2 <polls>` (one streamed call costing $0.0023–0.0030, then a tiny uncached call every 2–3 s) and `scripts/spend-limit.sh`.

**What the caller receives.** With `returnRawResponse: true`:

```json
{"status":429,"headers":{"cf-aig-event-id":"…","cf-aig-log-id":"01M3YRNVFEX2F0PM3CE8T8F2FW","cf-aig-request-id":"…","cf-aig-step":"0","content-type":"application/json"},
 "body":"{\"success\":false,\"result\":[],\"messages\":[],\"error\":[{\"code\":2045,\"message\":\"Spend limit exceeded: rule 'per-user' (cost limit 0.002 per 3600s, fixed) for internal-workers-ai @cf/meta/llama-3.2-3b-instruct\"}],\"name\":\"AiGatewayError\",\"httpCode\":429,\"internalCode\":2045,…}"}
```

Without it the binding throws:

```json
{"error":{"constructor":"InferenceUpstreamError","name":"AiGatewayError","message":"2045: Spend limit exceeded: rule 'per-user' (cost limit 0.002 per 3600s, fixed) for internal-workers-ai @cf/meta/llama-3.2-3b-instruct","ownKeys":["stack","message","name"]},"logId":"01M3YRNVNBD6SNRR4V6574MTZE"}
```

No `Retry-After` or remaining-budget header. `stream: true` fails the same way before any stream exists. The blocked request is logged (`status_code: 429`) and has a log id.

For comparison, the gateway's count-based rate limit (`rate_limiting_limit: 3`, `rate_limiting_interval: 60`, once):

```json
{"status":429,"headers":{"cf-aig-log-id":"01M3YS79ZW10EMBHT63T6T4K0Y",…},"body":"{\"success\":false,\"result\":[],\"messages\":[],\"error\":[{\"code\":2003,\"message\":\"Rate limited\"}],\"name\":\"AiGatewayError\",\"httpCode\":429,\"internalCode\":2003,\"message\":\"Rate limited\",\"description\":\"Rate limited\"}"}
```

thrown as `2003: Rate limited`. The Unified Billing rate limit (200 requests / 60 s) was not reached, so its shape is unknown.

**Unit.** `window` is seconds: the error text says `per 3600s` for `window: 3600`, and rules with `window: 60` cleared within a minute.

**Timing, all nine overspends.** "Passed" is the number of follow-up requests that still got `200` before the first `429`.

| Rule | Costly call done (cost) | Passed | First `429` | Last `429` | First `200` again |
| --- | --- | --- | --- | --- | --- |
| fixed, 3600 s | 16:54:53 ($0.00293) | 1 | 16:54:56 | — (not followed) | — |
| fixed, 60 s | 16:56:21 ($0.00248) | 1 | 16:56:24 | 16:56:58 | 16:57:00 |
| sliding, 60 s | 16:58:42 ($0.00252) | 1 | 16:58:45 | 16:59:11 | 16:59:13 |
| fixed, 60 s | **18:25:12 ($0.00296)** | **all 30** | **never** | — | — |
| fixed, 60 s | 18:27:24 ($0.00235) | 1 | 18:27:27 | 18:27:59 | 18:28:01 |
| fixed, 60 s, call 18:28:48 → 18:29:13 | 18:29:13 ($0.00272) | 1 | 18:29:16 | 18:29:58 | 18:30:00 |
| fixed, 60 s, rule enabled 5 s before the call | 18:32:23 ($0.00302) | 1 | 18:32:25 | (still blocked at 18:32:51) | — |
| fixed, 60 s | 18:33:30 ($0.00270) | 1 | 18:33:33 | (still blocked at 18:33:59) | — |
| sliding, 60 s | 18:35:22 ($0.00231) | 1 | 18:35:25 | 18:36:07 | 18:36:09 |

- **Bite.** In 8 of 9 the request sent immediately after the overspend passed and the next one, 2–3 s later, was blocked. The overspending request itself always completed (streamed, 1,000–1,300 output tokens, never cut).
- **The miss.** The 18:25:12 overspend was never enforced: 30 follow-up requests over 71 s all returned `200`, although the log shows the cost against the right metadata (`18:25:12.137 dur=46111 cost=0.0029642… meta={"user":"u-hank2"}`). It differs from the others in that the call ran 46 s (others 16–26 s), started 8 s after spend limits were first enabled on a new gateway, and crossed a minute boundary. Two of those were then tried on their own — a call crossing the boundary (18:28:48 → 18:29:13) and a call 5 s after enabling the rule on a gateway whose limits had been off — and both were enforced. Cause not found.
- **Fixed windows clear on the clock minute** (3 of 3: 16:57:00, 18:28:01, 18:30:00 — the polls are 2–3 s apart). The spend counts in the minute in which the call completed, not started (the 18:28:48 → 18:29:13 call blocked the 18:29 minute). So a 60-second fixed rule cleared 37–47 s after the spend here, never 60.
- **Sliding windows** (2 of 2) cleared when `spend × (60 − t)/60` fell under the limit, `t` being seconds into the next clock minute: predicted 12.4 s and 8.1 s, observed between 11–13 s and 7–9 s. That is the previous window weighted by its overlap, not a true rolling sum.

**Scope** (each observed once unless stated):

- Another `user` value was unaffected, and a request with no `user` key passed while two users were blocked.
- The rule covered every model: an embedding call for a blocked user was `429`.
- Counters survived the rule being re-`PUT` under the same id.
- Cache hits were served to a blocked user (`200`, `cached: true`, cost `0`): two identical cacheable requests, seconds after the same user got `429` on an uncached one.

**Design.** A per-user budget scoped by metadata works and the breach is distinguishable from rate limiting, so "catch the breach and downgrade in our own code" is viable without Dynamic Routing. The port has to parse the numeric prefix of the error message, or use `returnRawResponse` and read `internalCode`. _Inference:_ because one overspend in nine went unenforced and enforcement always trails by at least one request, treat gateway spend rules as a backstop and enforce per-change caps in the forge from logged cost. A calendar-month budget is expressible only as a fixed window of N seconds; where such a window is anchored was observed only for 60 s (clock minute). **Not observed:** any of this on a Unified Billing or BYOK Claude request; Dynamic Routing (`not tested` — needs BYOK or credits).

## 5. Embeddings — `works`

**Run:** `scripts/call.sh run '{"model":"@cf/baai/bge-m3","body":{"text":["decision: use hairlines not boxes","decision: one accent colour"]},"gateway":{"metadata":{"user":"u-alice","agent":"embed"}}}'`, then one call per other model with a single input.

**Came back** (vectors trimmed):

```json
{"returned":"object:Object","logId":"01M3YQN3VJW68NZT1QDD30WVT7",
 "result":{"data":[[0.0032939910888671875,-0.0259857177734375,…],[…]],"shape":[2,1024],"pooling":"cls","response":null,
           "meta":{"cost_metric_name_1":"input_tokens","cost_metric_value_1":20,"neurons":0.02149175737498028}}}
```

| Model | `shape` | Other fields in the result |
| --- | --- | --- |
| `@cf/baai/bge-m3` | `[2, 1024]` (two inputs) | `pooling: "cls"`, `meta`, `response: null` |
| `@cf/qwen/qwen3-embedding-0.6b` | `[1, 1024]` | `usage` with `neurons` |
| `@cf/google/embeddinggemma-300m` | `[1, 768]` | none |
| `@cf/baai/bge-large-en-v1.5` | `[1, 1024]` | `pooling: "mean"`, `usage` |
| `@cf/baai/bge-base-en-v1.5` | `[1, 768]` | `pooling: "mean"`, `usage` |
| `@cf/baai/bge-small-en-v1.5` | `[1, 384]` | `pooling: "mean"`, `usage` |

Request shape `{ text: string[] }` worked for all six. The gateway logged each call with a cost (`2.2e-7` for the two-sentence `bge-m3` call) and the metadata; `tokens_in` was `0` on the `bge-m3` log although the result reports 20 input tokens.

**Design.** The "no vector database" plan stands. Read the dimension from `shape` and store `pooling` with the vectors, since the default differed between `bge-m3` and the English `bge` models. Embedding spend shows up per user in the same logs as model spend.

## 6. Access in front of an app Worker — `works` with a service token; browser login `not tested`

**Run:** [`app/`](../../../spikes/gateway-access/app/) — a Worker with static assets (`not_found_handling: "single-page-application"`, `run_worker_first: ["/api/*", "/ws/*"]`), `/api/whoami`, and `/ws/*` forwarded to a Durable Object using the hibernation API. Access application created with

```json
{ "type": "self_hosted", "name": "gitflare-spike-g-app", "session_duration": "1h",
  "destinations": [{ "type": "public", "uri": "gitflare-spike-g-app.<subdomain>.workers.dev" }],
  "policies": [
    { "name": "gitflare-spike-g-svc", "decision": "non_identity", "include": [{ "service_token": { "token_id": "<id>" } }] },
    { "name": "gitflare-spike-g-people", "decision": "allow", "include": [{ "email_domain": { "domain": "example.com" } }] } ] }
```

and called with `scripts/access.sh`. Both sessions ran the script against the application with only the first policy, then with both. A hostname application on a `workers.dev` hostname needed no zone.

**Service token, `GET /api/whoami`** (static assets, hostname destination):

```json
{"headerNames":["accept","accept-encoding","cf-access-jwt-assertion","cf-connecting-ip","cf-ipcountry","cf-ray","cf-visitor","connection","cookie","host","user-agent","x-forwarded-proto","x-real-ip"],
 "jwtHeaderPresent":true,"cfAuthorizationCookiePresent":true,"clientSecretHeaderReachedWorker":false,
 "ctxAccess":"undefined","ctxKeys":["tracing","access","cache","props","exports"],
 "jwtProtectedHeader":{"typ":"JWT","alg":"RS256","kid":"…"},
 "jwtClaimsUnverified":{"type":"app","iat":1790960420,"exp":1790964021,"iss":"https://<team>.cloudflareaccess.com","sub":"","aud":"<aud>","common_name":"<client-id>.access","h_INTERNAL_DO_NOT_USE":"gitflare-spike-g-app.<subdomain>.workers.dev"},
 "joseVerify":{"ok":true,"ms":48,"claimNames":["aud","common_name","exp","h_INTERNAL_DO_NOT_USE","iat","iss","sub","type"]},
 "joseVerifyWrongAud":"JWTClaimValidationFailed: unexpected \"aud\" claim value"}
```

- **The JWT header reached Worker code** and `jwtVerify(token, createRemoteJWKSet(<team>/cdn-cgi/access/certs), { issuer, audience })` succeeded in every request that reached the Worker (28–110 ms including the JWKS fetch). The JWKS had two RS256 keys. `aud` in the token was a string, not the array the docs show; `jose` accepts both.
- The `CF-Access-Client-Id` / `-Secret` headers did not reach the Worker; a `CF_Authorization` cookie was present on the request the Worker saw and was set on the response.
- A service-token identity is `sub: ""` plus `common_name`, as documented. `exp − iat` was 3601 s with `session_duration: "1h"`.
- Static assets and the SPA fallback were served behind Access (`GET /` and `GET /some/spa/route` → `200 text/html`).

**A client-supplied `Cf-Access-Jwt-Assertion`** — `scripts/access.sh` step 6, second session, application with both policies:

```
--- bogus header, no credentials (does it reach the Worker?)
302
--- bogus header alongside a valid service token (which token does the Worker see?)
{'jwtHeaderPresent': True, 'joseVerify': {'ok': True, 'ms': 53, 'claimNames': ['aud', 'common_name', 'exp', 'h_INTERNAL_DO_NOT_USE', 'iat', 'iss', 'sub', 'type']}}
--- the JWT Access issued, replayed without the service token
cookie                     -> 200
cf-access-token            -> 200
Cf-Access-Jwt-Assertion    -> 200
Authorization              -> 302
```

A bogus header sent with valid credentials was replaced: the Worker verified a real token. A bogus header on its own never reached the Worker. A genuine, unexpired Access JWT is accepted by Access as a credential in the cookie, in `cf-access-token` and in `Cf-Access-Jwt-Assertion`. With only the service-token policy on the application all four replays were `403` (both sessions) — the only thing changed between the two results in the second session was adding the `allow` policy, so the policy set, not the destination type, decides whether the issued JWT can be replayed.

**`ctx.access`** (first session, one request each):

| Worker | Destination | `ctx.access` | `getIdentity()` |
| --- | --- | --- | --- |
| static assets, `run_worker_first: ["/api/*","/ws/*"]` | hostname (`public`) | `undefined` | — |
| static assets, `run_worker_first: true` | hostname | `undefined` | — |
| static assets, array form | Worker-level (`worker`) | `undefined` | — |
| no static assets | Worker-level | object, `aud` equals the application's | `undefined` (service token) |
| no static assets | hostname | object, `aud` equals the application's | `undefined` (service token) |

Outputs, trimmed: `{"jwtHeaderPresent":true,"ctxAccess":"undefined","joseVerify":{"ok":true,…}}` for the first three; `{"jwtHeaderPresent":true,"ctxAccess":"object","ctxAccessAudMatches":true,"ctxAccessIdentity":null,"joseVerify":{"ok":true,…}}` for the last two. The key `access` exists on `ctx` in every case.

**WebSocket upgrade to the Durable Object.** Raw upgrade with `curl --http1.1`; the object's first frame echoes what the Worker saw. Hostname destination, service token (`scripts/access.sh` step 5):

```
HTTP/1.1 101 Switching Protocols
Connection: upgrade
Upgrade: websocket
Sec-WebSocket-Accept: XoSQxCDk2IwDpa9Vq5JShUfWKCM=
{"hello":"from Room","seenByWorker":{"jwtHeaderPresent":true,"joseVerify":{"ok":true,"ms":50,…},"ctxAccess":"undefined"}}
```

Worker-level destination. The application was `PUT` at 18:21:50 with `"destinations": [{ "type": "worker", "worker_id": "<32-hex id from GET /accounts/<account-id>/workers/workers>" }]`, and a `GET` of the application straight after returned exactly that one destination and no `domain`. `scripts/access-ws.sh`, three times (18:22:41, 18:23:45, 18:24:08), same output each time:

```
=== 18:23:45
control, no credentials, GET /api/whoami : 302
control, no credentials, WS upgrade      : HTTP/1.1 302 Found Location: https://<team>.cloudflareaccess.com/cdn-cgi/access/login/gitflare-spike-g-app.<subdomain>.workers.dev?kid=<aud>&meta=…&redirect_url=%2Fws%2Froom1
control, wrong secret, WS upgrade        : HTTP/1.1 302 Found
service token, WS upgrade:
HTTP/1.1 101 Switching Protocols
Upgrade: websocket
{"hello":"from Room","seenByWorker":{"jwtHeaderPresent":true,"joseVerify":{"ok":true,"ms":103,…},"ctxAccess":"undefined"}}
```

The controls show the hostname was still protected by this application (the redirect carries its `kid`) while its only destination was the Worker, and that an upgrade without valid credentials was refused. The first session saw the same `101` with the service token (with and without static assets) and with the cookie alone (with static assets); its only control was the unauthenticated upgrade in the same script run, which got `302`. What this does not establish: how Cloudflare evaluates a `worker` destination internally, and what a browser WebSocket (interactive session, `Origin` header) gets. The docs' `403` was not reproduced; that is all.

**Unauthenticated** (`scripts/access.sh` steps 1, 2 and 7; both sessions):

| Request | Application has only the service-token policy | Application also has an `allow` policy |
| --- | --- | --- |
| `GET /`, `GET /api/whoami` | `403`, HTML error page (JSON body with `Accept: application/json`), headers `cf-access-aud`, `cf-access-domain` | `302` to `https://<team>.cloudflareaccess.com/cdn-cgi/access/login/<host>?kid=<aud>&meta=…&redirect_url=…`, sets `CF_AppSession` |
| same with `X-Requested-With: XMLHttpRequest` | `403` | `401`, HTML body |
| WebSocket upgrade | `403` | `302` |
| wrong service-token secret | `403` | `302` |

Step 7 with the `allow` policy, second session, verbatim:

```
accept: application/json             -> 302
sec-fetch-mode: cors                 -> 302
sec-fetch-mode: navigate             -> 302
x-requested-with: XMLHttpRequest     -> 401
--- response to X-Requested-With: XMLHttpRequest
HTTP/2 401
content-type: text/html; charset=UTF-8
www-authenticate: Cloudflare-Access resource_metadata="https://gitflare-spike-g-app.<subdomain>.workers.dev/.well-known/cloudflare-access-protected-resource/api/whoami"
access-control-allow-headers: x-requested-with
access-control-allow-credentials: true
<head><title>401 Unauthorized</title></head>
--- discovery documents
{"resource":"https://gitflare-spike-g-app.<subdomain>.workers.dev","protected":true,"team_domain":"<team>.cloudflareaccess.com","authorization_servers":["https://<team>.cloudflareaccess.com"],"authentication_methods":[{"name":"cloudflared",…}]} [200]
```

The `302` carries the same `www-authenticate` header. Managed OAuth was not enabled. `https://<team>.cloudflareaccess.com/.well-known/oauth-authorization-server` answered `200` (first session) and matches the research note's quoted document except that `issuer` includes `https://` and there is no `registration_endpoint`.

**Design.** Validate `Cf-Access-Jwt-Assertion` with `jose` everywhere; do not branch on `ctx.access`. _Inference:_ the SPA's `fetch` calls should send `X-Requested-With: XMLHttpRequest`, so that a lapsed session produces a `401` instead of a cross-origin redirect — observed with `curl`, not in a browser. For live status, the WebSocket path worked behind both destination types with a service token; keep the research note's hostname-or-SSE fallback in the design until the same is seen with a browser session.

**Untested, because a human login cannot be driven from here:**

- A browser session: the claims of a user token (`email`, a non-empty `sub`, `identity_nonce`), `getIdentity()` returning an identity, and whether `user_uuid` equals `sub`.
- A browser WebSocket (cookie from an interactive login, `Origin` header) through either destination type.
- Who can log in under an email-domain policy on this organisation (it has the `cloudflare` and `onetimepin` identity providers; a fresh one may not).
- Managed OAuth (`gitflare login`): not enabled, no token minted. Only the discovery documents were fetched.
- `access.dev` locally, and `cf.user_id` through an Access-protected gateway custom domain (needs a zone).

## Spend and cleanup

- **Spend.** Workers AI usage by the gateway's own cost figures: $0.0114 in the first session (299 logged requests at the last count) and $0.0164 in the second (213), $0.028 together, roughly 2,500 neurons at $0.011 per 1,000. Claude: $0 — 76 calls, none served. Workers, Durable Object and Access usage: a few hundred requests. Estimated total under $0.05 of the $3 limit. The credit balance was 0 before and after.
- **Created, both sessions:** gateway `gitflare-spike-g-gw`; Workers `gitflare-spike-g-ai` and `gitflare-spike-g-app` (with its Durable Object namespace); Access application `gitflare-spike-g-app` (its two policies inline, not reusable); service token `gitflare-spike-g-token`.
- **Deleted, both sessions:** all of the above (`DELETE` on the application, service token and gateway returned `202`/`200`/`200`; `wrangler delete` reported both Workers deleted).
- **Nothing is left over.** Verified after each session by listing gateways, Worker scripts, Durable Object namespaces, Access applications, service tokens and reusable Access policies and filtering on the `gitflare-spike-g-` prefix: all six lists empty (last check 2026-10-02T18:37:15Z). The same listing showed the pre-existing gateways, Worker and Access application still present. Nothing pre-existing was modified; no billing, plan, member, token, DNS or identity-provider change was made.
