# AI Gateway, Workers AI and Cloudflare Access

Verified 2026-10-02 against live docs.

Method: every page was fetched as raw markdown (`<url>/index.md`), signatures were read from the published npm tarballs, and API payloads from the API reference. **Nothing here was executed against a live Cloudflare account** — no model was called and no resource was created. Where a conclusion combines two documented facts but the combination itself is not documented, it is marked _(composed, untested)_ and repeated under [Could not verify](#could-not-verify).

Package versions read: `@cloudflare/workers-types` 5.20261002.1, `wrangler` 4.147.0, `workers-ai-provider` 4.0.0, `ai-gateway-provider` 4.0.1, `jose` 6.2.12, `@anthropic-ai/sdk` 0.131.0, `ai` 7.0.127, `@cloudflare/vitest-pool-workers` 0.22.0.

Shorthand for source URLs: `CF` = `https://developers.cloudflare.com`.

## What this forces

1. **Do not expect `cf.user_id` on calls made through the `env.AI` binding** _(deduction, not a documented statement — untested)_. Documented: `cf.user_id` "is only present on requests that arrive through an Access-protected custom domain with a valid Access user subject", service-token requests do not get it, and custom domains do not work with `api.cloudflare.com`. A binding call carries no Access JWT and does not go through a custom domain, so by those rules it gets none; no page says so in terms of the binding. A custom domain also needs a zone, so a workers.dev-only deployment has no route to it. Plan for the forge's own agents to pass the user as ordinary custom metadata and for spend rules to partition on that key.
2. **Metadata is capped at five entries per request and spend rules at twenty per gateway.** The metadata vocabulary (user, agent, change, session, …) is a fixed, shared contract of at most five keys. A spend rule is a budget over a _time window_, so "at most $X for this change, ever" is not directly expressible; a per-change cap has to be enforced by the forge from logged cost.
3. **Call Claude with `env.AI.run("anthropic/<model>", <Anthropic Messages body>, { gateway })`.** Anthropic is passed through in its native Messages format (request and response), not normalised to OpenAI. The call is untyped (`Record<string, unknown>` in and out), so it must sit behind a typed port owned by us. Structured output via `output_config.format` is accepted by the published schema but has no documented example — smoke-test it before depending on it.
4. **Budget fallback through Dynamic Routing is only reachable in OpenAI chat-completions format.** Documented: a route is called as `dynamic/<name>` through the OpenAI-compatible `/compat/chat/completions` endpoint, "Dynamic routing is not currently available on the REST API", and both routing pages ask for BYOK. Also documented: the spend-limits page describes exactly this fallback with `anthropic/claude-opus-4.7` as the primary model, so a Claude model _can_ sit inside a route. _Inference (untested):_ a caller that sends Anthropic Messages — Claude Code on the provider-native endpoint, or the binding call in bullet 3 — is not calling a route, so on breach it receives the documented `429` rather than a fallback. Either call Claude through a route in OpenAI format, or catch the `429` and downgrade in our own code. Whether routes work with Unified Billing is unresolved (see Could not verify).
5. **There is no documented cost response header.** Per-request cost exists only on the gateway log entry (`cost`), is documented as an estimate, and is read after the fact by log id or by metadata filter. Per-change cost in the UI is therefore a sum over log entries and must be labelled an estimate.
6. **`gitflare login` does not need `cloudflared`.** Access Managed OAuth (beta) turns the Access application into a standard OAuth 2.0 authorization server: authorization code + PKCE, loopback redirect, dynamic client registration, refresh tokens. The CLI gets an opaque bearer token; the Worker still receives the normal `Cf-Access-Jwt-Assertion`.
7. **One Access application can cover a Worker on workers.dev, custom domains and previews (`destinations: [{ type: "worker" }]`), but Worker-level Access rejects WebSocket upgrades with `403`.** If live status uses WebSockets, protect by hostname instead (or stream over SSE). `ctx.access` exists but is not passed to a Worker that has Static Assets (including via the Vite plugin), so validating the JWT header with `jose` is the portable path.
8. **New Zero Trust organisations default to the Cloudflare identity provider restricted to account members; one-time PIN is no longer added automatically.** _Inference (untested):_ with only that provider available, a person who is not a member of the Cloudflare account has no way to log in, whatever the policy allows, until an identity provider such as `onetimepin` is added (one API call). This is in tension with the Workers page's policy option, which says Email domain "Allows anyone with a verified email address at the domain you enter … even if they are not Cloudflare account members"; the docs do not say which login method those people use on a fresh organisation. Creating the organisation asks for a plan and payment details even on the free plan.
9. **AI Gateway tokens are account-scoped.** Any token with `AI Gateway Run` can use every gateway in the account, including its stored provider keys. Never place one inside a sandbox; inject credentials and metadata in Worker code on egress. Unified Billing is also rate limited to 200 requests per 60 seconds per gateway (BYOK is exempt).
10. **No vector database for the decision record.** A few hundred short records fit in Worker memory; Vectorize and the AI binding have no local simulation, so every added binding is another thing to fake in tests. Embed with Workers AI, store vectors next to the index, compute cosine in the Worker.

## Verified facts

### Calling a model from a Worker: the `env.AI` binding

Wrangler config (source: `CF/ai-gateway/usage/worker-binding-methods/`):

```jsonc
{
	"ai": {
		"binding": "AI",
	},
}
```

Third-party model through a gateway (same source):

```ts
const resp = await env.AI.run(
	"openai/gpt-4.1-mini",
	{
		messages: [{ role: "user", content: "tell me a joke" }],
	},
	{
		gateway: {
			id: "default", // or use a specific gateway name
		},
	},
);
```

- "Third-party models require an AI Gateway and use Unified Billing." `id` must name a gateway in the same account; `"default"` is auto-created on the first authenticated request. (same source; `CF/ai-gateway/configuration/manage-gateway/`)
- Binding calls are pre-authenticated; no `cf-aig-authorization` header is needed. (`CF/ai-gateway/configuration/authentication/`)

Types, from `@cloudflare/workers-types` 5.20261002.1 `index.d.ts`:

```ts
type GatewayRetries = {
  maxAttempts?: 1 | 2 | 3 | 4 | 5;
  retryDelayMs?: number;
  backoff?: "constant" | "linear" | "exponential";
};
type GatewayOptions = {
  id: string;
  cacheKey?: string;
  cacheTtl?: number;
  skipCache?: boolean;
  metadata?: Record<string, number | string | boolean | null | bigint>;
  collectLog?: boolean;
  eventId?: string;
  requestTimeoutMs?: number;
  retries?: GatewayRetries;
};
type AiOptions = {
  queueRequest?: boolean;
  websocket?: boolean;
  tags?: string[];
  gateway?: GatewayOptions;
  returnRawResponse?: boolean;
  prefix?: string;
  extraHeaders?: object;
  signal?: AbortSignal;
};
```

The overload that third-party model names hit — inputs and outputs are untyped:

```ts
  // Names that aren't in `AiModelList` — e.g. third-party gateway models
  // like `"google/nano-banana"` — still hit this overload.
  run<Model extends string>(
    model: Model extends keyof AiModelList ? never : Model,
    inputs: Record<string, unknown>,
    options?: AiOptions,
  ): Promise<Record<string, unknown>>;
```

Other overloads on the same class: `inputs & { stream: true }` returns `Promise<ReadableStream>`; `options & { returnRawResponse: true }` returns `Promise<Response>`. Both are declared only for known (`@cf/…`) model names; for a third-party name TypeScript resolves to the untyped overload above regardless of what the runtime returns.

Gateway handle and log type (same file):

```ts
declare abstract class Ai<AiModelList extends AiModelListType = AiModels> {
  aiGatewayLogId: string | null;
  gateway(gatewayId: string): AiGateway;
  // …
}
declare abstract class AiGateway {
  patchLog(logId: string, data: AiGatewayPatchLog): Promise<void>;
  getLog(logId: string): Promise<AiGatewayLog>;
  run(
    data: AIGatewayUniversalRequest | AIGatewayUniversalRequest[],
    options?: {
      gateway?: UniversalGatewayOptions;
      extraHeaders?: object;
      signal?: AbortSignal;
    },
  ): Promise<Response>;
  getUrl(provider?: AIGatewayProviders | string): Promise<string>; // eslint-disable-line
}
type AIGatewayUniversalRequest = {
  provider: AIGatewayProviders | string; // eslint-disable-line
  endpoint: string;
  headers: Partial<AIGatewayHeaders>;
  query: unknown;
};
```

### Anthropic models: identifiers, request format, streaming, tools

Each model has a catalog page whose slug is the identifier. Read on 2026-10-02 (`CF/ai/models/anthropic/<slug>/`):

| Identifier | Context | Input / output per 1M tokens | Cached input / cache creation |
| --- | --- | --- | --- |
| `anthropic/claude-fable-5.1` | 1,000,000 | $10.00 / $50.00 | $0.25 / $12.50 |
| `anthropic/claude-opus-5.5` | 1,000,000 | $4.00 / $20.00 | $0.20 / $5.00 |
| `anthropic/claude-sonnet-5` | 1,000,000 | $2.00 / $10.00 | $0.20 / $2.50 |
| `anthropic/claude-haiku-4.5` | 200,000 | $1.00 / $5.00 | $0.10 / $1.25 |

The catalog index (`CF/ai/models/`) also lists `claude-fable-5`, `claude-opus-5`, `claude-opus-4.8`, `-4.7`, `-4.6`, `-4.5`, `claude-sonnet-4.6`, `-4.5`. Prices are the catalog's and can change; read them from the catalog, do not hard-code.

- Identifier spelling is inconsistent across docs: the catalog and the 2026-09-01 changelog entry (`CF/ai-gateway/changelog/`) use dots (`anthropic/claude-haiku-4.5`), while examples on `CF/ai-gateway/usage/rest-api/` use hyphens (`anthropic/claude-sonnet-4-5`). Use the catalog slug. The provider-native endpoint (below) takes Anthropic's own ids without a prefix (its examples use `claude-sonnet-4-5`).
- Every Anthropic catalog page states "Request formats: Anthropic Messages". The binding takes the Anthropic body directly (source: `CF/ai/models/anthropic/claude-sonnet-5/`):

```ts
const response = await env.AI.run(
  'anthropic/claude-sonnet-5',
  {
    max_tokens: 1024,
    messages: [{ content: 'How do I read a JSON file in Python?', role: 'user' }],
    system: 'You are a helpful coding assistant specializing in Python.',
  },
)
```

- The response is an Anthropic message plus one gateway field (same page, abbreviated):

```json
{
  "id": "msg_01RdqxfAYz2PfZTfiAYpX6Tz",
  "type": "message",
  "role": "assistant",
  "content": [{ "type": "text", "text": "…" }],
  "model": "claude-sonnet-5",
  "stop_reason": "end_turn",
  "usage": { "input_tokens": 20, "output_tokens": 539 },
  "stop_sequence": null,
  "stop_details": null,
  "gatewayMetadata": { "keySource": "Unified" }
}
```

- Streaming: pass `stream: true` in the body. The documented output is the Anthropic event sequence (`message_start`, `content_block_start`, `ping`, `content_block_delta` with `text_delta`, …); `message_start.message.usage` carries `input_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`, `output_tokens`. (same page, "Streaming Response" example)
- Thinking and effort are set in the body: `output_config: { effort: 'high' }, thinking: { type: 'adaptive' }`. (same page)
- Tools: the documented example is Anthropic's server-side web search, passed in the native `tools` array through the binding (`CF/ai-gateway/usage/web-search/`):

```js
const resp = await env.AI.run(
	"anthropic/claude-haiku-4.5",
	{
		max_tokens: 4096,
		messages: [{ role: "user", content: "…" }],
		tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 3 }],
	},
	{ gateway: { id: "default" } },
);
```

- Published input schemas (`CF/ai/models/anthropic/<slug>/schema-input.json`):
  - `claude-sonnet-5` declares `messages`, `max_tokens`, `system`, `stream`, `metadata`; `claude-haiku-4.5` adds `temperature`, `top_p`, `top_k`.
  - `claude-opus-5.5` additionally declares `thinking` (`type: "adaptive"`, `display: "summarized" | "omitted"`), `output_config` (`effort: "low" | "medium" | "high" | "xhigh" | "max"`, and `format: {}` with no further constraint), `tools` (array of objects, open), and `tool_choice` as `oneOf` `{ type: "auto", disable_parallel_tool_use? }` or `{ type: "none" }`.
  - All three set top-level `additionalProperties: {}` (undeclared fields are allowed by the schema) and declare `system` as `type: "string"`.
- `workers-ai-provider` 4.0.0 README confirms the pass-through: the unified catalog "normalizes most providers to OpenAI chat-completions … but **passes Anthropic through natively**".

### REST endpoints and their auth

Source: `CF/ai-gateway/usage/rest-api/`.

| Endpoint (under `https://api.cloudflare.com/client/v4/accounts/{account_id}`) | Format | Third-party | Workers AI (`@cf/`) |
| --- | --- | --- | --- |
| `POST /ai/run` | Envelope with `model`, `input` | yes | yes |
| `POST /ai/v1/chat/completions` | OpenAI chat completions | yes | yes |
| `POST /ai/v1/responses` | OpenAI Responses | yes | model dependent |
| `POST /ai/v1/messages` | Anthropic Messages | yes | no |

- Auth: a Cloudflare API token with **Account > Workers AI > Read**, sent as `Authorization: Bearer`. "A token that holds only an `AI Gateway` permission returns `401` with error code `10000`." `AI Gateway` permissions apply only to `/accounts/{account_id}/ai-gateway/*` (configuration, logs, routes).
- Gateway selection: third-party requests use the account's default gateway unless `cf-aig-gateway-id: <id>` is sent; Workers AI requests always require that header.
- Per-request headers: `cf-aig-skip-cache`, `cf-aig-cache-ttl`, `cf-aig-cache-key`, `cf-aig-collect-log`, `cf-aig-request-timeout` (ms), `cf-aig-max-attempts` (max 5), `cf-aig-retry-delay` (ms, max 60000), `cf-aig-backoff`, `cf-aig-metadata` (JSON string).

Anthropic SDK against the REST API (same source):

```javascript
import Anthropic from "@anthropic-ai/sdk";

const anthropic = new Anthropic({
	apiKey: CLOUDFLARE_API_TOKEN,
	baseURL: `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/ai/v1`,
});

const message = await anthropic.messages.create({
	model: "anthropic/claude-sonnet-4-5",
	max_tokens: 512,
	messages: [{ role: "user", content: "What is Cloudflare?" }],
});
```

The OpenAI SDK and `@ai-sdk/openai` use the same base URL, `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/ai/v1`. (same source; `CF/ai-gateway/configuration/authentication/`)

### Provider-native endpoint (what Claude Code talks to)

Source: `CF/ai-gateway/usage/providers/anthropic/`.

```txt
https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_id}/anthropic
```

```bash
curl https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_id}/anthropic/v1/messages \
 --header 'cf-aig-authorization: Bearer {CF_AIG_TOKEN}' \
 --header 'anthropic-version: 2023-06-01' \
 --header 'Content-Type: application/json' \
 --data  '{
    "model": "claude-sonnet-4-5",
    "max_tokens": 1024,
    "messages": [
      {"role": "user", "content": "What is Cloudflare?"}
    ]
  }'
```

- That form (no `x-api-key`) is the documented "With Stored Keys (BYOK) / Unified Billing" call. "When using BYOK or Unified Billing, do not set `x-api-key` in `defaultHeaders`. AI Gateway supplies the Anthropic key for you, and adding your own `x-api-key` header will cause the request to fail."
- From a Worker, the base URL is available without hard-coding the account id (`CF/ai-gateway/usage/worker-binding-methods/`):

```typescript
import { createAnthropic } from "@ai-sdk/anthropic";

const anthropic = createAnthropic({
	baseURL: await env.AI.gateway("my-gateway").getUrl("anthropic"),
});
```

### Vercel AI SDK

- `workers-ai-provider` (`CF/ai-gateway/integrations/vercel-ai-sdk/`):

```ts
import { createWorkersAI } from "workers-ai-provider";
import { streamText } from "ai";

const workersai = createWorkersAI({
	binding: env.AI,
	gateway: { id: "my-gateway" },
});
const result = streamText({
	model: workersai("openai/gpt-4o"),
	messages: [{ role: "user", content: "Write a short story" }],
});
```

- For `anthropic/…` slugs the package's README (4.0.0) requires the Anthropic wire-format plugin — `createWorkersAI({ binding: env.AI, providers: [anthropic] })` with `import { anthropic } from "workers-ai-provider/anthropic"` and `@ai-sdk/anthropic` as a peer — and labels the whole third-party path: "**Experimental.** … APIs may change, and several behaviors depend on undocumented AI Gateway internals".
- `ai-gateway-provider` 4.0.1 wraps `@ai-sdk/*` providers and calls `gateway.ai.cloudflare.com` with a gateway token: `createAiGateway({ accountId, gateway, apiKey })`, then `aigateway(anthropic('…'))` with `createAnthropic` from `ai-gateway-provider/providers/anthropic`. (same docs page)

### Which route to use for Claude with structured output

Recommendation, from the facts above:

1. **Default: the binding**, `env.AI.run("anthropic/<slug>", body, { gateway: { id, metadata } })`. It is the documented current path, needs no secret in the Worker, and takes the Anthropic body unchanged. Put the JSON schema in `output_config.format` _(accepted by the published schema as an unconstrained object; no documented example — untested)_.
2. **Fallback if (1) rejects or ignores a field: the provider-native Anthropic endpoint**, which is a pass-through of Anthropic's own API. Reach it either with a gateway token as a Worker secret and `@ai-sdk/anthropic` / `@anthropic-ai/sdk` pointed at `getUrl("anthropic")`, or through the binding's `env.AI.gateway(id).run({ provider: "anthropic", endpoint: "v1/messages", headers, query })` _(signature verified in the types; this specific call is composed, untested)_.
3. Do not build on `workers-ai-provider`'s third-party routing yet: it is self-described experimental.

Keep the choice behind one interface (model id, messages, tools, schema in; typed result, usage and gateway log id out) so swapping (1) for (2) touches one file.

### BYOK versus Unified Billing

Sources: `CF/ai-gateway/features/unified-billing/`, `CF/ai-gateway/configuration/bring-your-own-keys/`, `CF/ai-gateway/reference/pricing/`.

- **Unified Billing**: prepaid credits loaded in the dashboard (AI Gateway > Credits Available > Manage > Top-up credits), optional auto top-up (threshold + recharge amount). "A 5% fee is applied to all credits purchased"; provider pricing is passed through with no markup. "In rare instances, your credit balance may go negative", charged at the start of the next month. The gateway must be authenticated.
- **Credential precedence** on every request: (1) a provider key on the request is forwarded unchanged; (2) otherwise a stored key under the `default` alias; (3) otherwise Unified Billing.
- **BYOK**: keys live in Secrets Store. Dashboard: gateway > Provider Keys > Add API Key. API: create the Secrets Store secret first, named `{gateway_id}_{provider_slug}_{alias}` (for example `my-gateway_anthropic_default`), then:

```bash
curl https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/ai-gateway/gateways/$GATEWAY_ID/provider_configs \
    -H 'Content-Type: application/json' \
    -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
    -d '{
          "alias": "alias",
          "default_config": true,
          "provider_slug": "provider_slug"
        }'
```

  Body fields: `alias`, `default_config`, `provider_slug` (required); `secret` (store a new key), `secret_id`, `rate_limit`, `rate_limit_period` (optional). Permission: `Secrets Store Write`. (`CF/api/resources/ai_gateway/subresources/provider_configs/methods/create/`)
- **What changes in calling code: nothing**, provided the key is stored under the `default` alias. "On the AI binding path, only a BYOK key stored under the `default` alias is used. Keys stored under other aliases are not consulted, and the request falls through to Unified Billing." `cf-aig-byok-alias` works only on provider-native requests. The Anthropic response reports which was used in `gatewayMetadata.keySource`.
- **Forbid silent fall-through to Unified Billing**: set `byok_only: true` on the gateway (dashboard: "Require provider credentials"), or per request `cf-aig-no-wholesale: true`. Requests without credentials then return HTTP `400`. Workers AI requests are unaffected.
- **Workers AI billing through a gateway**: `workers_ai_billing_mode` is `"postpaid"` (default, billed to the account) or `"unified"` (deducts credits).
- **Zero Data Retention** (`zdr` on the gateway) applies only to Unified Billing requests, not BYOK, and does not control gateway logging.
- **Limits**: Unified Billing is limited to 200 requests per 60 seconds per gateway (`429` beyond), not applied to BYOK. Gateways per account: 10 free, 20 paid. (`CF/ai-gateway/reference/limits/`)

### Creating a gateway and its rules through the API

`POST /accounts/{account_id}/ai-gateway/gateways`, permission `AI Gateway Write` (`CF/api/resources/ai_gateway/methods/create/`). `PUT` on `/gateways/{id}` updates.

```bash
curl https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/ai-gateway/gateways \
    -H 'Content-Type: application/json' \
    -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
    -d '{
          "id": "my-gateway",
          "cache_invalidate_on_update": true,
          "cache_ttl": 0,
          "collect_logs": true,
          "rate_limiting_interval": 0,
          "rate_limiting_limit": 0
        }'
```

Required: `id` (1–64 chars), `cache_invalidate_on_update`, `cache_ttl`, `collect_logs`, `rate_limiting_interval`, `rate_limiting_limit`. Optional fields relevant here: `authentication`, `byok_only`, `spend_limits`, `workers_ai_billing_mode`, `zdr`, `store_id`. The `spend_limits` shape, from the reference's response example:

```json
    "spend_limits": {
      "enabled": true,
      "rules": [
        {
          "limit": 1,
          "limitType": "cost",
          "window": 1,
          "id": "x",
          "enabled": true,
          "metadata": {
            "foo": {
              "mode": "partition"
            }
          },
          "model": {
            "mode": "filter",
            "values": [
              "string"
            ]
          },
          "provider": {
            "mode": "filter",
            "values": [
              "string"
            ]
          },
          "technique": "fixed"
        }
      ]
    },
```

Rule schema: `limit: number` (> 0), `limitType: "cost"`, `window: number` (> 0), optional `id`, `enabled`, `technique: "fixed" | "sliding"`, `metadata: map[{ mode: "partition" } | { mode: "filter", values: string[] }]`, `model: { mode: "filter", values }`, `provider: { mode: "filter", values }`.

Mapping to the dashboard terms (`CF/ai-gateway/features/spend-limits/`): "Split by value" = `partition` (each distinct value gets its own bucket); "Filter by value" = `filter`. A dimension not configured on a rule means all values share one bucket.

### Spend limits

Source: `CF/ai-gateway/features/spend-limits/`.

- Up to 20 rules per gateway. Rules apply to Unified Billing and to BYOK requests "for models with known pricing".
- Evaluation: "Before sending a request to the provider, AI Gateway evaluates all applicable spend limit rules at once. If any individual rule is over budget, the request is blocked with a `429` response."
- "Spend limits are eventually consistent. The current request's cost is recorded after completion, so a burst of concurrent requests can briefly exceed the limit before enforcement catches up."
- Per user, per agent, per change: one rule per dimension with the metadata key in `partition` mode. Dimensions combine: a rule with two partitioned keys has one bucket per combination.
- **Deployment-wide budget**: a rule with no dimensions is "One shared bucket" ("Global budget for everyone").
- What the caller sees on breach: `429 Too Many Requests` until the window resets.
- Fallback: "Create a Dynamic Route with a primary model and a fallback … Then set a spend limit on the primary model … When the primary model's budget is exceeded, AI Gateway automatically routes requests to the fallback model instead of blocking them." Subject to the Dynamic Routing constraints below.
- The account-level endpoints `GET|POST|DELETE /accounts/{account_id}/ai-gateway/billing/spending-limit` are marked **deprecated** in the API reference; per-gateway `spend_limits` is the current mechanism. Credit balance and auto top-up are readable and settable under `/ai-gateway/billing/credit-balance` and `/ai-gateway/billing/topup/config`. (`CF/api/resources/ai_gateway/`)

### Custom metadata

Source: `CF/ai-gateway/observability/custom-metadata/`.

- Up to **five** entries per request; extras are dropped. Values are string, number or boolean; objects are not supported.
- Keys beginning `cf.` are reserved and stripped if sent by the caller.
- Binding: `gateway: { id, metadata: { team: "AI", user: 12345, test: true } }`. HTTP: header `cf-aig-metadata: {"team": "AI", "user": 12345, "test":true}`.

### Dynamic Routing

Sources: `CF/ai-gateway/features/dynamic-routing/`, `…/json-configuration/`, `…/usage/`.

- A route is a named, versioned graph of elements: `start`, `conditional`, `percentage`, `rate` (count or cost limit with `success`/`fallback` outputs), `model`, `end`. It is called by using `dynamic/<route-name>` as the model.
- "The OpenAI-compatible endpoint is marked **Deprecated** for standard single-model chat completions, but it remains the required way to call dynamic routes. Dynamic routing is not currently available on the REST API."
- Both the overview and the usage page carry: "Ensure your gateway has authentication turned on, and you have your upstream providers keys stored with BYOK."
- Budget element, as documented (`limitType` is `"count"` or `"cost"`, `window` is "Time window in seconds"):

```json
{
	"id": "<id>",
	"type": "rate",
	"properties": {
		"limitType": "count",
		"key": "metadata.user_id",
		"limit": 100,
		"window": 3600
	},
	"outputs": {
		"success": { "elementId": "node_model_workers_ai" },
		"fallback": { "elementId": "node_model_openai_mini" }
	}
}
```

- From a Worker:

```ts
const response = await env.AI.gateway("default").run({
	provider: "compat",
	endpoint: "chat/completions",
	headers: {},
	query: {
		model: "dynamic/<your-dynamic-route-name>",
		messages: [{ role: "user", content: "What is Cloudflare?" }],
	},
});
```

- Response headers `cf-aig-model` and `cf-aig-provider` report what actually served the request.
- API: `POST /accounts/{account_id}/ai-gateway/gateways/{gateway_id}/routes` (`{ name, elements }`), `POST …/routes/{id}/versions` (`{ elements }`), `POST …/routes/{id}/deployments` (`{ version_id }`); permission `AI Gateway Write`. A version serves no traffic until deployed.

### Cost of an individual request

- The log entry carries it. From `@cloudflare/workers-types` 5.20261002.1:

```ts
type AiGatewayLog = {
  id: string;
  provider: string;
  model: string;
  model_type?: string;
  path: string;
  duration: number;
  request_type?: string;
  request_content_type?: string;
  status_code: number;
  response_content_type?: string;
  success: boolean;
  cached: boolean;
  tokens_in?: number;
  tokens_out?: number;
  metadata?: Record<string, number | string | boolean | null | bigint>;
  step?: number;
  cost?: number;
  custom_cost?: boolean;
  request_size: number;
  request_head?: string;
  request_head_complete: boolean;
  response_size: number;
  response_head?: string;
  response_head_complete: boolean;
  created_at: Date;
};
```

- From a Worker: `const myLogId = env.AI.aiGatewayLogId;` ("Returns the log ID from the most recent `env.AI.run()` request"), then `await env.AI.gateway("my-gateway").getLog("my-log-id")`. (`CF/ai-gateway/usage/worker-binding-methods/`) Because the property is "most recent", read it immediately after the awaited call and do not share one `env.AI` call site across concurrent requests without care.
- Over HTTP the id is the `cf-aig-log-id` response header. (`CF/ai-gateway/glossary/`)
- REST: `GET /accounts/{account_id}/ai-gateway/gateways/{gateway_id}/logs` and `…/logs/{id}`; permission `AI Gateway Read`. Entries include `cost`, `tokens_in`, `tokens_out`, `model`, `provider`, `metadata` (a string), `created_at`. List supports `filters: [{ key, operator, value }]` where `key` includes `metadata.key`, `metadata.value`, `cost`, `model`, `provider`, `created_at`, and `operator` is `eq | neq | contains | lt | gt`; `per_page` max 50; `search` is free text over metadata. This is how traffic that did not go through the binding (a coding agent) is attributed. (`CF/api/resources/ai_gateway/subresources/logs/methods/list/`)
- No response header carrying cost is listed in the header glossary. The Anthropic response body carries `usage` token counts, so cost can also be computed locally from catalog prices as a cross-check.
- Reliability: "The cost metric is an **estimation** based on the number of tokens sent and received in requests … refer to your provider's dashboard for the most **accurate** cost details." "Cost metrics are only available for endpoints where the models return token data and the model name in their responses." (`CF/ai-gateway/observability/costs/`)
- Cache hits: "If a response is served from cache (cache hit), the cost is always `0`, even if you specified a custom cost." (closing note on `CF/ai-gateway/configuration/custom-costs/`, re-fetched 2026-10-02)
- Logs must be on (`collect_logs`, or per request `cf-aig-collect-log`). `cf-aig-collect-log-payload: false` keeps cost and token metadata while not storing prompt and response bodies. (`CF/ai-gateway/observability/logging/`)
- Log storage: accounts whose first gateway was created on or after 2026-09-24 follow Workers Logs pricing and retention; earlier accounts keep legacy limits (10 million logs per gateway on paid). (`CF/ai-gateway/reference/limits/`)
- Aggregates: dashboard analytics, the GraphQL dataset `aiGatewayRequestsAdaptiveGroups` (documented example returns `count` by `model`, `provider`, `gateway`), and User Insights, which attributes spend per identity from custom metadata or Access. (`CF/ai-gateway/observability/analytics/`, `…/user-insights/`)

### A coding agent behind the gateway (Claude Code)

Source: `CF/ai-gateway/integrations/coding-agents/claude-code/`.

```bash
export ANTHROPIC_BASE_URL="https://gateway.ai.cloudflare.com/v1/<ACCOUNT_ID>/<GATEWAY_ID>/anthropic"
export ANTHROPIC_API_KEY="<CF_AIG_TOKEN>"
export ANTHROPIC_CUSTOM_HEADERS="cf-aig-authorization: Bearer <CF_AIG_TOKEN>"
```

- Prerequisites: an authenticated gateway and a gateway token with `Run` permission. With Unified Billing or a stored key, "the `ANTHROPIC_API_KEY` value is ignored. Claude Code still requires the variable to be set, so you can set it to any value".
- Claude Code's own reference confirms the variables: `ANTHROPIC_BASE_URL` ("Override the API endpoint to route requests through a proxy or gateway"), `ANTHROPIC_AUTH_TOKEN` (sent as `Authorization: Bearer …`), `ANTHROPIC_API_KEY` (sent as `X-Api-Key`), and `ANTHROPIC_CUSTOM_HEADERS` ("`Name: Value` format, newline-separated for multiple headers"). (`https://code.claude.com/docs/en/env-vars`)
- With the gateway behind Access (custom domain), the documented setup is an `apiKeyHelper`, after which requests carry `cf.user_id`:

```json
{
	"apiKeyHelper": "cloudflared access login --no-verbose https://ai-gateway.example.com",
	"env": {
		"ANTHROPIC_BASE_URL": "https://ai-gateway.example.com/anthropic"
	}
}
```

- Attaching metadata: add a second line to `ANTHROPIC_CUSTOM_HEADERS`, `cf-aig-metadata: {"user":"…","session":"…"}` _(composed from the two documented facts above; Cloudflare's Claude Code page does not show it — untested)_.
- Token scope: "The `AI Gateway Read`, `Run`, and `Edit` permissions cannot be restricted to a single gateway … Any token with `AI Gateway Run` can send requests through every gateway in the account, including any configured with stored provider keys". Cloudflare's stated alternatives are separate accounts or "a Worker-side AI Gateway binding". (`CF/ai-gateway/configuration/authentication/`)
- Consequence for a hosted session: point the agent's `ANTHROPIC_BASE_URL` at a URL the forge controls and add authentication and metadata in Worker code, so that neither a gateway token nor a metadata value the agent could forge lives in the container _(design recommendation; the egress mechanics belong to the Sandbox research note)_.
- DLP response scanning buffers the full provider response and so delays the first streamed token; use request-only checks for coding agents. (`CF/ai-gateway/integrations/coding-agents/`)

### Embeddings

Workers AI text-embedding models (`CF/workers-ai/models/<name>/`, read 2026-10-02):

| Model | Output dimensions | Max input tokens | Price per 1M input tokens | Notes |
| --- | --- | --- | --- | --- |
| `@cf/baai/bge-small-en-v1.5` | 384 | 512 | $0.0202 | English; batch |
| `@cf/baai/bge-base-en-v1.5` | 768 | 512 | $0.0666 | English; batch |
| `@cf/baai/bge-large-en-v1.5` | 1,024 | 512 | $0.204 | English; batch; 1,500 req/min |
| `@cf/baai/bge-m3` | not stated | context window 60,000 | $0.0118 | multilingual |
| `@cf/qwen/qwen3-embedding-0.6b` | not stated | context window 8,192 | $0.0118 | |
| `@cf/google/embeddinggemma-300m` | not stated | not stated | not stated | beta; 100+ languages |
| `@cf/pfnet/plamo-embedding-1b` | not stated | not stated | $0.0186 | Japanese |

- Call and result shape differ per model in `@cloudflare/workers-types` 5.20261002.1. `@cf/baai/bge-base-en-v1.5` (the `-small-` and `-large-` types have the same form):

```ts
type Ai_Cf_Baai_Bge_Base_En_V1_5_Input =
  | {
      text: string | string[];
      pooling?: "mean" | "cls";
    }
  | {
      requests: {
        text: string | string[];
        pooling?: "mean" | "cls";
      }[];
    };
type Ai_Cf_Baai_Bge_Base_En_V1_5_Output =
  | {
      shape?: number[];
      data?: number[][];
      pooling?: "mean" | "cls";
    }
  | Ai_Cf_Baai_Bge_Base_En_V1_5_AsyncResponse;
interface Ai_Cf_Baai_Bge_Base_En_V1_5_AsyncResponse {
  request_id?: string;
}
```

  (doc comments omitted). Every output field is optional and the result is a union with the async-batch response, so code must narrow before reading `data`. `@cf/google/embeddinggemma-300m` instead maps to the generic `BaseAiTextEmbeddings`, whose types are `{ text: string | string[] }` in and `{ shape: number[]; data: number[][] }` out. `bge-m3` and `qwen3-embedding-0.6b` have their own generated types, not copied here.
- Elsewhere in the same file a `shape` field is documented as "Shape of the embedding data as [number_of_embeddings, embedding_dimension]", so where `shape` is present the dimension can be read at runtime instead of assumed.
- On `pooling`, the type comment says `cls` "will generate more accurate embeddings on larger inputs - however, embeddings created with cls pooling are not compatible with embeddings generated with mean pooling" and that the default is `mean`. Fix one and record it with the stored vectors.
- Rate limit: 3,000 requests per minute for text embeddings. Pricing unit: $0.011 per 1,000 neurons, 10,000 neurons per day free. (`CF/workers-ai/platform/limits/`, `…/pricing/`)
- **Vectorize** (`CF/vectorize/platform/limits/`, `…/pricing/`): up to 1,536 dimensions, 20,000,000 vectors per index, `topK` 50 with values or metadata, 10 KiB metadata per vector; paid plans include 50 million queried vector dimensions per month. No local simulation — remote binding only (`CF/workers/local-development/bindings-per-env/`).
- **AI Search** (`CF/ai-search/platform/limits-pricing/`): billing starts 2026-11-01; included per month are 5 million ingestion tokens, 10 GB-month storage, 1,000 semantic and 1,000 full-text queries; then $0.75 per 1M ingestion tokens, $2.00 per GB-month, $0.75 per 1,000 semantic/vector/hybrid queries. Its embedding usage "does not appear on your Workers AI bill or in your AI Gateway logs". Local development, from a different page (`CF/ai-search/api/search/workers-binding/`): "Local development is supported by proxying requests to your deployed AI Search instance. Add `remote: true` to your binding configuration".
- **Assessment for a few hundred short decision records**: neither is warranted. 500 records at 1,024 float32 dimensions is about 2 MB; a full cosine scan is a few hundred thousand multiplications. Embedding the whole corpus once (about 100,000 tokens) costs a few cents at most at the prices above. Storing vectors with the forge's own index avoids a binding that cannot run locally and keeps embedding spend visible in the gateway. Revisit only if a deployment reaches tens of thousands of records. _(Judgement from the limits above, not a measured result.)_

### Cloudflare Access: protecting the Worker

Source: `CF/workers/configuration/cloudflare-access/`.

- Requires a Zero Trust organisation on the account.
- Options and their API destination types: all Workers (`all_workers`), all previews (`all_preview_workers`), one Worker (`worker`), one Worker's previews (`preview_worker`), or a specific hostname/path (a self-hosted application domain).
- Protecting one Worker "automatically protects every domain associated with the Worker, including its routes, Custom Domains, `workers.dev` hostname, and previews".
- **"Worker-level Access policies do not currently support WebSocket connections. WebSocket upgrade requests to a Worker protected by a worker-level Access policy will fail with a `403` error."** The documented alternative is a hostname-based Access application.
- Precedence when several apply: hostname or path first, then Worker-level, then account-level.

### Cloudflare Access: validating the JWT in a Worker

Source: `CF/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/`.

- The token arrives in the `Cf-Access-Jwt-Assertion` request header (and, for browsers, the `CF_Authorization` cookie). "We recommend validating the `Cf-Access-Jwt-Assertion` header instead of the `CF_Authorization` cookie, since the cookie is not guaranteed to be passed."
- Team domain: `https://<your-team-name>.cloudflareaccess.com`. JWKS: `https://<your-team-name>.cloudflareaccess.com/cdn-cgi/access/certs`. Keys are RS256, rotate every 6 weeks, and the previous key stays valid for 7 days — fetch the key set, do not pin a key.
- AUD: each Access application has an Application Audience tag; it "will never change unless you delete or recreate the Access application". It is returned as `aud` by the application API.
- Recommended library `jose`; the documented Worker (TypeScript):

```ts
import { jwtVerify, createRemoteJWKSet } from "jose";

interface Env {
	POLICY_AUD: string;
	TEAM_DOMAIN: string;
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		// Verify the POLICY_AUD environment variable is set
		if (!env.POLICY_AUD) {
			return new Response("Missing required audience", {
				status: 403,
				headers: { "Content-Type": "text/plain" },
			});
		}

		// Get the JWT from the request headers
		const token = request.headers.get("cf-access-jwt-assertion");

		// Check if token exists
		if (!token) {
			return new Response("Missing required CF Access JWT", {
				status: 403,
				headers: { "Content-Type": "text/plain" },
			});
		}

		try {
			// Create JWKS from your team domain
			const JWKS = createRemoteJWKSet(
				new URL(`${env.TEAM_DOMAIN}/cdn-cgi/access/certs`)
			);

			// Verify the JWT
			const { payload } = await jwtVerify(token, JWKS, {
				issuer: env.TEAM_DOMAIN,
				audience: env.POLICY_AUD,
			});

			// Token is valid, proceed with your application logic
			return new Response(
				`Hello ${payload.email || "authenticated user"}!`,
				{
					headers: { "Content-Type": "text/plain" },
				}
			);
		} catch (error) {
			// Token verification failed
			const message = error instanceof Error ? error.message : "Unknown error";
			return new Response(`Invalid token: ${message}`, {
				status: 403,
				headers: { "Content-Type": "text/plain" },
			});
		}
	},
};
```

  `TEAM_DOMAIN` is `https://<your-team-name>.cloudflareaccess.com`; `POLICY_AUD` is the AUD tag.

### Cloudflare Access: identity claims

Source: `CF/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/application-token/`.

```json
{
	"aud": ["32eafc7626e974616deaf0dc3ce63d7bcbed58a2731e84d06bc3cdf1b53c4228"],
	"email": "user@example.com",
	"exp": 1659474457,
	"iat": 1659474397,
	"nbf": 1659474397,
	"iss": "https://yourteam.cloudflareaccess.com",
	"type": "app",
	"identity_nonce": "6ei69kawdKzMIAPF",
	"sub": "7335d417-61da-459d-899c-0a01c76a2f94",
	"country": "US"
}
```

- `email`: "verified by the identity provider". `sub`: "The ID of the user. This value is unique to an email address per account. The user would get a different `sub` if they are removed and re-added to your Zero Trust organization".
- **Groups are not in the token by default.** "Identity provider groups are only included in the token when you explicitly configure `groups` as a custom SAML attribute or OIDC claim." Custom claims are trimmed when the `custom` claim exceeds roughly 1 KB. The full identity (including `idp`, `groups`, `user_uuid`) comes from `https://<your-team-name>.cloudflareaccess.com/cdn-cgi/access/get-identity` with the `CF_Authorization` cookie.
- A service-token request has `"sub": ""` and `common_name` set to the token's Client ID — it carries no user.
- Sessions: application token lifetime follows the application/policy session duration (default 24 hours); global session default 24 hours. (`CF/cloudflare-one/access-controls/access-settings/session-management/`)

`ctx.access` (`CF/workers/configuration/cloudflare-access/`; types from `@cloudflare/workers-types` 5.20261002.1):

```ts
interface CloudflareAccessContext {
  readonly aud: string;
  getIdentity(): Promise<CloudflareAccessIdentity | undefined>;
}
interface CloudflareAccessIdentity extends Record<string, unknown> {
  email?: string;
  name?: string;
  user_uuid?: string;
  account_id?: string;
  iat?: number;
  ip?: string;
  amr?: string[];
  idp?: { id: string; type: string };
  geo?: { country: string };
  groups?: Array<{ id: string; name: string; email?: string }>;
  devicePosture?: Record<string, unknown>;
  is_warp?: boolean;
  is_gateway?: boolean;
}
```

- "`ctx.access` is `undefined` if Access did not authenticate the request."
- Not propagated through Service Bindings or RPC.
- "Workers with Static Assets execute behind an internal router Worker. Access still protects the application and its assets. However, the router does not pass `ctx.access` to the user Worker." The Vite plugin can add `assets` implicitly, so frameworks using it are affected.
- `ctx.access` exposes no `sub`. Use the JWT's `sub` when the value has to match AI Gateway's `cf.user_id`.

### How identity reaches AI Gateway as `cf.user_id`

Sources: `CF/ai-gateway/configuration/cloudflare-access/`, `…/observability/custom-metadata/`, `…/configuration/custom-domains/`.

- Preconditions: the gateway has a **custom domain**, and that domain is protected by Access (gateway > Access tab).
- "When a request reaches AI Gateway through a custom domain protected by Cloudflare Access, AI Gateway adds the authenticated Access user ID to request metadata as `cf.user_id`. This value is the verified Access JWT `sub` claim, not the user's email address."
- On that domain the Access JWT is the credential; no gateway token is needed. Requests carrying only a gateway token are blocked by Access there. `gateway.ai.cloudflare.com` stays outside Access.
- "Service-token requests do not include `cf.user_id`." If five custom entries are already present, the last may be dropped to make room for `cf.user_id`.
- Custom domains serve provider-native and `compat` routes only; "They do not work with the Cloudflare REST API (`api.cloudflare.com`)." Creating one through the API needs a `zone_id` and a proxied CNAME to the returned `cname_target`.
- Per-user rule: metadata key `cf.user_id`, split by value; to target one person, filter on that user's `sub`.
- A Worker can forward a user's Access JWT to another Access application in the `Cf-Access-Token` header when that application's policy uses the Linked App Token selector. (`CF/cloudflare-one/access-controls/applications/linked-app-token/`)

### Cloudflare Access for a CLI

**Device flow: not available.** No device authorization grant (RFC 8628) is documented for Access. The authorization-server metadata shown on `CF/cloudflare-one/access-controls/authenticate-agents/` lists `grant_types_supported: ["authorization_code", "refresh_token"]` only, and a search of the Managed OAuth and coding-agent pages finds no mention of a device grant. **Browser-redirect flow without `cloudflared`: available**, through Managed OAuth (authorization code + PKCE with a loopback redirect), described below. A machine with no local browser is therefore left with `cloudflared access login` (it prints a URL to open elsewhere) or a service token.

Three supported ways, compared:

| | Managed OAuth | `cloudflared` | Service token |
| --- | --- | --- | --- |
| Extra install | none | `cloudflared` binary | none |
| Identity | the user | the user | none (`sub` is empty) |
| Credential | opaque `oauth:…` access token + refresh token | application JWT | Client ID + Client Secret |
| Sent as | `Authorization: Bearer <token>` | `cf-access-token: <jwt>` | `CF-Access-Client-Id` / `CF-Access-Client-Secret` |
| Lifetime | access token default 15 min; refresh until grant session ends | application session duration | until expiry or revocation |
| Policy | ordinary identity policies | ordinary identity policies | needs a `Service Auth` policy |

**Managed OAuth** (`CF/cloudflare-one/access-controls/applications/http-apps/managed-oauth/`; the API reference marks `oauth_configuration` **Beta**):

- Without it, non-browser clients "receive a `302` redirect with no usable token or authorization endpoint". With it, Access returns `401` with a `WWW-Authenticate` header pointing at OAuth metadata. Enabling it "replaces the `401` response behavior on the protected application".
- Enable on an application by `PUT /accounts/{account_id}/access/apps/{app_id}` (the body must contain all fields from the preceding `GET`):

```bash
	--json '{
		"oauth_configuration": {
				"enabled": true,
				"dynamic_client_registration": {
						"enabled": true,
						"allow_any_on_localhost": true,
						"allow_any_on_loopback": true,
						"allowed_uris": [
								"https://playground.ai.cloudflare.com/*"
						]
				},
				"grant": {
						"access_token_lifetime": "5m",
						"session_duration": "24h"
				}
		}
	}'
```

- Recommended for CLIs by Cloudflare: access token lifetime 5–15 minutes with a grant session of 1–2 weeks; policies are re-evaluated on every refresh.
- Step-by-step flow. **Provenance: this comes from an example agent skill (an `AGENTS.md` snippet) embedded in `CF/cloudflare-one/access-controls/authenticate-agents/`, not from reference documentation.** The Managed OAuth reference page describes the same flow only in outline (discovery metadata, authorization code flow in the browser, token issued). Treat the endpoint paths and payloads below as illustrative until checked against a real application's discovery document: `401` with `resource_metadata="https://<hostname>/.well-known/cloudflare-access-protected-resource/"` → that document lists `authorization_servers` → `https://<team>.cloudflareaccess.com/.well-known/oauth-authorization-server`:

```json
{
	"issuer": "<team>.cloudflareaccess.com",
	"authorization_endpoint": "https://<team>.cloudflareaccess.com/cdn-cgi/access/oauth/authorization",
	"token_endpoint": "https://<team>.cloudflareaccess.com/cdn-cgi/access/oauth/token",
	"response_types_supported": ["code"],
	"response_modes_supported": ["query"],
	"grant_types_supported": ["authorization_code", "refresh_token"],
	"token_endpoint_auth_methods_supported": [
		"client_secret_basic",
		"client_secret_post",
		"none"
	],
	"revocation_endpoint": "https://<team>.cloudflareaccess.com/cdn-cgi/access/oauth/revoke",
	"registration_endpoint": "https://<team>.cloudflareaccess.com/cdn-cgi/access/oauth/registration",
	"code_challenge_methods_supported": ["S256"]
}
```

  then: register a public client (`token_endpoint_auth_method: "none"`, `redirect_uris: ["http://localhost:8400/callback"]`, `resource: "https://<hostname>"`), open the authorization URL with `code_challenge_method=S256` and `resource=…`, catch the code on the loopback listener, exchange it. Token response:

```json
{
	"access_token": "oauth:<token>",
	"token_type": "bearer",
	"expires_in": 900,
	"scope": "",
	"resource": "https://<hostname>/",
	"refresh_token": "oauth:<refresh_token>"
}
```

- Documented pitfall: the PKCE code challenge must start with `[a-zA-Z0-9]`; a leading `-` or `_` fails with `code_challenge_method must be S256 for public clients`.
- The Managed OAuth page also names `https://<your-app-domain>/.well-known/oauth-authorization-server` as the metadata location. Discover from the `401` rather than hard-coding either.
- "Managed OAuth issues **opaque** access tokens … When a client presents an opaque token to your application, Cloudflare resolves the token into the user's identity on the backend and forwards a signed assertion to your origin. From your origin's perspective, the request looks the same as a browser-authenticated request." So the Worker's JWT validation is unchanged.
- Requires an OAuth client that supports RFC 8707 (the `resource` parameter).

**`cloudflared`** (`CF/cloudflare-one/tutorials/cli/`, `…/authenticate-agents/`):

```sh
cloudflared access login https://example.com
cloudflared access token -app=http://example.com
curl -H "cf-access-token: $TOKEN" https://example.com/rest/api/2/item/foo-123
```

  `login` opens the browser (or prints a URL), stores the token, and prints it (`CF_TOKEN=$(cloudflared access login https://example.com)`). The token is valid for the application's session duration; after that a new browser login is needed.

**Service tokens** (`CF/cloudflare-one/access-controls/service-credentials/service-tokens/`): `POST /accounts/{account_id}/access/service_tokens` with `{ "name", "duration" }` (permission `Access: Service Tokens Write`) returns `client_id` and `client_secret` once. The application needs a policy with action Service Auth. New secrets use the format `cfast_…` since 2026-08-26.

**Recommendation for `gitflare login`**: Managed OAuth. It needs no second binary, yields a per-user credential, refreshes silently, and re-checks the Access policy on every refresh. The CLI stores the refresh token in the OS keychain. The git credential helper does not present the Access token to git: Artifacts remotes take Artifacts tokens, so the helper calls a forge endpoint with the bearer token and receives a short-lived repo-scoped Artifacts token. Trade-offs: the feature is beta; access tokens are short-lived, so the CLI must refresh; the loopback redirect needs a browser on the same machine (headless machines need `cloudflared access login`, which prints a URL, or a service token with no user identity); and enabling it changes unauthenticated non-browser responses from `302` to `401`. Keep `cloudflared` as the documented fallback.

### Access setup through the API

Application: `POST /accounts/{account_id}/access/apps`, permission `Access: Apps and Policies Write`. Documented example for one Worker (`CF/workers/configuration/cloudflare-access/`):

```bash
curl "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/access/apps" \
  --request POST \
  --header "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  --json '{
    "type": "self_hosted",
    "name": "Access for my-worker",
    "destinations": [
      {
        "type": "preview_worker",
        "worker_id": "c81a2d22c29840ed9d61681a3270dbff"
      }
    ],
    "policies": [
      {
        "decision": "allow",
        "include": [
          {
            "email_domain": {
              "domain": "example.com"
            }
          }
        ]
      }
    ]
  }'
```

"To protect the Worker's production and preview deployments, use `worker` instead":

```json
"destinations": [
  {
    "type": "worker",
    "worker_id": "c81a2d22c29840ed9d61681a3270dbff"
  }
]
```

From `CF/api/resources/zero_trust/subresources/access/subresources/applications/methods/create/`:

- Destination types: `{ type: "public", uri }` (hostname with optional path and `*` wildcards — used for a workers.dev hostname or a custom domain alike), `{ type: "worker", worker_id }`, `{ type: "preview_worker", worker_id }`, `{ type: "all_workers" }`, `{ type: "all_preview_workers" }`. `destinations` supersedes `self_hosted_domains`.
- `overrides: [{ behavior: "public", path_pattern }]` on a public or Worker destination makes matching paths bypass Access. Patterns do not implicitly cover subpaths; use a wildcard.
- `policies` is an array, in ascending precedence, of reusable-policy references or inline policies; "Reusable and inline policies are mutually exclusive."
- Other fields used here: `name`, `domain`, `session_duration`, `allowed_idps`, `auto_redirect_to_identity` (needs exactly one IdP in `allowed_idps`), `oauth_configuration`, `options_preflight_bypass`, `cors_headers`. The response carries `aud`.

Reusable policy: `POST /accounts/{account_id}/access/policies` with `name`, `decision` (`"allow" | "deny" | "non_identity" | "bypass"`) and `include` (plus optional `exclude`, `require`, `session_duration`). Rule shapes (`…/policies/methods/create/`):

```json
{ "email_domain": { "domain": "example.com" } }
{ "email": { "email": "person@example.com" } }
{ "email_list": { "id": "<list uuid>" } }
{ "everyone": {} }
{ "service_token": { "token_id": "<uuid>" } }
{ "any_valid_service_token": {} }
```

A list of addresses is several `email` rules in one `include` (rules in `include` are OR-ed).

Organisation and identity providers:

- `GET /accounts/{account_id}/access/organizations` returns `auth_domain` (the team domain). `POST` on the same path creates the organisation (`auth_domain`, `name` required; permission `Access: Organizations, Identity Providers, and Groups Write`).
- Dashboard onboarding requires "selecting a subscription plan and entering your payment details. If you chose the **Zero Trust Free plan**, this step is still needed but you will not be charged." (`CF/cloudflare-one/setup/`)
- "New Zero Trust organizations use the Cloudflare identity provider as their default login method. OTP is no longer added automatically". The auto-added Cloudflare IdP has **Restrict to account members** enabled. (`CF/cloudflare-one/integrations/identity-providers/one-time-pin/`, `…/cloudflare/`)
- Adding one-time PIN:

```bash
curl "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/access/identity_providers" \
	--request POST \
	--header "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
	--json '{
		"name": "One-time PIN login",
		"type": "onetimepin",
		"config": {}
	}'
```

## Local development and tests

**AI binding**

- "bindings connect to local resource simulations (except for AI bindings, as AI models always run remotely)". The support table lists AI as no local simulation, remote connection only; the same holds for Vectorize. (`CF/workers/local-development/`, `…/bindings-per-env/`)
- "Using Workers AI always accesses your Cloudflare account in order to run AI models and will incur usage charges even in local development." Local inference also counts against rate limits. (`CF/ai-gateway/integrations/aig-workers-ai-binding/`, `CF/workers-ai/platform/limits/`)
- `wrangler dev` therefore needs a logged-in account for any model call, and each call is real spend through the real gateway. wrangler 4.147.0's config schema has `ai.remote` ("Whether the AI binding should be remote or not in local development").
- Unit and integration tests under `@cloudflare/vitest-pool-workers` cannot simulate the binding. **Needs a fake**: an in-memory implementation of our model port returning canned Anthropic-shaped messages, `usage`, and a log id. A small opt-in suite can run against a real gateway.
- Spend limits, logs, cost, Dynamic Routing and BYOK exist only on Cloudflare. **Needs a fake** for the "cost of this log id" and "budget exceeded (`429`)" paths.

**Access**

- Nothing sits in front of `wrangler dev`; no `Cf-Access-Jwt-Assertion` header arrives.
- `ctx.access` can be simulated (wrangler 4.147.0 schema confirms `access.dev` with required `aud` and optional `identity`):

```jsonc
{
	"access": {
		"dev": {
			"aud": "my-app",
			"identity": { "email": "admin@example.com" }
		}
	}
}
```

  "Wrangler will not start without" `aud` when the block is present; removing the block makes `ctx.access` `undefined`. The simulated identity accepts any fields of the production shape.
- That block does not produce a JWT, and `ctx.access` is unavailable in production for Workers with Static Assets, so it cannot be the only path. A sensible stand-in: one `identify(request)` function with two implementations — production verifies the JWT with `jose`; development returns a fixed identity from a dev-only variable (`.dev.vars`) and refuses to load when `TEAM_DOMAIN`/`POLICY_AUD` are set.
- The verification code itself is testable offline: generate an RSA key pair with `jose`, sign a token with the documented claims, and serve the JWKS from a stubbed fetch.
- Managed OAuth, `cloudflared access login`, one-time PIN and service tokens need a real Access application. **Cannot run locally**; the CLI's login flow needs a fake authorization server (or a manual check against a real deployment).

**Docker**: nothing in this note needs Docker. Running Claude Code in a container is covered by the Sandbox research note.

## Could not verify

Nothing was run against a live account (project rule: no Cloudflare resources created or modified, and a model call is real spend). Everything below would be settled by one short script on a real deployment.

- **Structured (JSON schema) output for Claude through the gateway.** Only `claude-opus-5.5`'s published schema names `output_config.format`, as an unconstrained object; there is no documented example on any Anthropic catalog page or on the REST page. Tried: all four fetched catalog pages, their `schema-input.json`, the REST, binding and web-search pages. Not confirmed that the field is honoured on `env.AI.run` or `/ai/v1/messages`.
- **Forced tool choice.** The `claude-opus-5.5` schema lists only `{ type: "auto" }` and `{ type: "none" }` for `tool_choice`. Whether `{ type: "tool", name }` or `{ type: "any" }` is rejected is unknown.
- **Client-defined tools.** The only documented `tools` example is Anthropic's server-side web search. Custom tool definitions are permitted by the schema (open objects) but not shown.
- **`system` as an array of blocks** (needed for `cache_control` on the system prompt). The schemas declare `system` as a string; whether the array form is accepted is unknown. `cache_control` on message content blocks is in the schema.
- **Whether the published schemas are enforced** or only descriptive.
- **Runtime return type of `env.AI.run` for a third-party model with `stream: true`** (the types give `Record<string, unknown>`; the docs show the event list, not the object type) and whether `returnRawResponse: true` works for third-party models.
- **Spend rule `window` unit.** The API reference types it as a positive number with no unit. Dynamic Routing's `window` is documented in seconds; the changelog speaks of "$200/day". Whether a calendar month can be expressed (`technique: "fixed"` with which anchor) is not documented.
- **The `429` on breach**: body, headers, and whether it is distinguishable from the Unified Billing rate limit and gateway rate limiting, which also return `429`. Also whether an in-flight streamed response is cut when a budget is crossed.
- **Dynamic Routing with Unified Billing.** Both routing pages require BYOK; the spend-limits page's fallback example uses catalog names (`anthropic/claude-opus-4.7` → `@cf/moonshotai/kimi-k2.6`). Not resolved.
- **What an Anthropic-format caller gets when a spend limit is breached and a route with a fallback exists.** The note infers a plain `429`, because such a caller does not address the route. Not documented either way, and not tested. Also unknown: whether a route can be invoked in Anthropic Messages format at all (only the OpenAI-compatible form is documented).
- **`cf.user_id` on binding calls.** Its absence is deduced from the documented conditions (Access-protected custom domain plus a user JWT), not stated for the binding and not observed.
- **Who can log in to a fresh Zero Trust organisation under an email-domain policy.** The identity-provider pages say new organisations get only the Cloudflare IdP with "Restrict to account members" enabled and no one-time PIN; the Workers Access page says the Email domain option admits people "even if they are not Cloudflare account members". The note infers that an extra identity provider is needed for non-members. Tried: `CF/workers/configuration/cloudflare-access/`, `CF/cloudflare-one/integrations/identity-providers/cloudflare/`, `…/one-time-pin/`, `CF/cloudflare-one/setup/`. Not resolved; the Workers dashboard flow may add a login method itself.
- **The Managed OAuth endpoint paths and payloads.** They are quoted from an example agent skill on the coding-agents page, not from a reference page, and were not fetched from a real application.
- **Log availability and latency.** How soon after a response `getLog(logId)` returns a populated `cost`, and whether `cost` is set for streamed Anthropic responses.
- **A cost field in the GraphQL dataset.** The documented query returns only `count`.
- **`cf-aig-metadata` from Claude Code via `ANTHROPIC_CUSTOM_HEADERS`.** Each half is documented; the combination is not shown by Cloudflare.
- **`env.AI.gateway(id).run({ provider: "anthropic", … })`** as a pre-authenticated pass-through, including streaming. The signature is in the types; the documented example uses `provider: "compat"`.
- **Embedding dimensions** for `bge-m3`, `qwen3-embedding-0.6b`, `embeddinggemma-300m`, `plamo-embedding-1b`: not stated on their Cloudflare model pages. Read `shape` at runtime.
- **Managed OAuth on a `worker` destination and on workers.dev.** The prerequisite says "a self-hosted Access application"; hostname versus Worker destination is not discussed.
- **`ctx.access` for requests authenticated by a Managed OAuth token or a service token**, and what `getIdentity()` returns for them.
- **Whether `user_uuid` from `getIdentity()` equals the JWT `sub`.** Both are described as "the ID of the user"; equality is not stated.
- **Where `worker_id` comes from.** The examples show a 32-hex id; `GET /accounts/{account_id}/workers/workers` returns objects with an `id`, but no page states that this is the value.
- **Creating a Zero Trust organisation purely through the API** on an account that has never completed the dashboard's plan-and-payment step.
- **Access seat limits and pricing** were not checked.
