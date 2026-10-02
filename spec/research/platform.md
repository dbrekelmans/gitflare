# Workers platform

Verified 2026-10-02 against live docs.

Method: pages fetched as markdown from `developers.cloudflare.com/<path>/index.md`; signatures cross-checked against the published typings (`npm pack`). Nothing here was executed — no Worker was built, run or deployed. Where docs and typings disagree, both are given.

Package versions read (npm `latest` on 2026-10-02):

| Package | Version | Note |
| --- | --- | --- |
| `wrangler` | 4.147.0 | `engines.node >= 22.0.0` |
| `@cloudflare/vite-plugin` | 1.62.5 | peers: `vite ^6.1.0 \|\| ^7.0.0 \|\| ^8.0.0`, `wrangler ^4.147.0`; `beta` tag is `2.0.0-beta.*` |
| `@cloudflare/vitest-plugin` | 1.3.6 | peers: `vitest ^4.1.0` |
| `@cloudflare/vitest-pool-workers` | 0.22.0 | superseded, see Testing |
| `vitest` | 5.0.3 | **outside** the vitest plugin's peer range |
| `vite` | 8.3.2 | |
| `miniflare` | 5.20261001.0-alpha | this alpha is the `latest` tag and is what wrangler 4.147.0 depends on |
| `@cloudflare/workers-types` | 5.20261002.1 | README recommends `wrangler types` instead |
| `agents` | 0.25.0 | peers include `ai ^6 \|\| ^7`, `zod ^4`, `react ^19` |
| `@cloudflare/ai-chat` | 0.12.1 | peers: `agents >=0.25.0 <1.0.0`, `ai ^6 \|\| ^7`, `react ^19`, `@ai-sdk/react ^3 \|\| ^4` |
| `@cloudflare/think` | 0.20.0 | |
| `cf` | 1.0.0-beta.11 | the new Cloudflare CLI |
| `drizzle-orm` / `drizzle-kit` | 0.45.3 / 0.31.11 | `rc` tag is `1.0.0-rc.4` |

## What this forces

- **A Worker with static assets does not receive `ctx.access`.** The single-Worker "React SPA + API" shape runs behind an internal asset router that does not pass the Access context on, and the Vite plugin adds assets to the deployed config even when the input config omits them. Identity cannot be read from `ctx.access` in that shape; "who is this request from" needs its own port and a different mechanism (see Could not verify).
- **The Vitest integration was renamed and is pinned below current Vitest.** Use `@cloudflare/vitest-plugin` (1.3.6), not `@cloudflare/vitest-pool-workers`. It requires `vitest ^4.1.0`; `vitest@latest` is 5.0.3, so pin Vitest 4.
- **Do not adopt `cloudflare.config.ts` yet; use `wrangler.jsonc`.** It is open beta and only usable through the beta `cf` CLI; Wrangler commands do not read it, and running `cf dev/build/deploy` in a Wrangler project rewrites project files.
- **Durable Object `migrations` is now the legacy path.** New Workers declare classes in an `exports` map. The two are mutually exclusive per Worker and the switch to `exports` is one-way, so pick before the first deploy. Agents SDK and Drizzle docs still show `migrations`.
- **`WorkflowInstance.subscribe()` is a Worker-side RPC stream, not a browser transport.** A browser needs a Worker or Durable Object in between. The documented browser-facing primitive is a Durable Object with hibernatable WebSockets (one object per change); the subscription is best used for catch-up from a cursor.
- **Relational records belong in D1; Durable Object SQLite is for per-object state.** Limits and SQL pricing are identical, but only D1 has migration tooling, an HTTP API, cross-entity queries and test helpers. See the D1 section for the full trade-off.
- **The Agents SDK fits the per-comment conversation and is heavier than a plain DO.** `AIChatAgent` supplies persistence, resumable streaming, multi-client sync, tools and approvals; the cost is a pre-1.0 package (0.25.0, published 2026-10-02), its own WebSocket protocol and `/agents/:agent/:name` URL convention, and a large peer set. Keep it behind an interface.
- **Everything asynchronous is at-least-once.** Queue batches are retried whole unless messages are acked individually; Workflow steps and DO alarms re-run on failure. Every handler in the push pipeline must be idempotent.
- **Event subscriptions are not declared in Wrangler config.** They are created per queue with `wrangler queues subscription create` (or the dashboard), so an installer must create them as a separate step.
- **New-project baseline:** Node >= 22, `compatibility_date` = today, no `nodejs_compat` flag (default from 2026-08-04), no `enable_ctx_exports` flag (default from 2025-11-17).

## Verified facts

### Project shape: one Worker, React SPA + API

Sources: https://developers.cloudflare.com/workers/vite-plugin/tutorial/ · https://developers.cloudflare.com/workers/static-assets/routing/single-page-application/ · https://developers.cloudflare.com/workers/static-assets/routing/worker-script/ · https://developers.cloudflare.com/workers/vite-plugin/reference/static-assets/ · https://developers.cloudflare.com/workers/wrangler/configuration/#assets

`vite.config.ts` (`@cloudflare/vite-plugin` 1.62.5) — the Cloudflare plugin goes after the framework plugin:

```ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { cloudflare } from "@cloudflare/vite-plugin";

export default defineConfig({
	plugins: [react(), cloudflare()],
});
```

`wrangler.jsonc` with explicit Worker routes:

```jsonc
{
  "$schema": "./node_modules/wrangler/config-schema.json",
  "name": "cloudflare-vite-tutorial",
  // Set this to today's date
  "compatibility_date": "2026-10-02",
  "main": "./worker/index.ts",
  "assets": {
    "not_found_handling": "single-page-application",
    "run_worker_first": [
      "/api/*"
    ]
  }
}
```

- `assets.directory` is not set with the Vite plugin; the build output points it at the client build. `vite build` writes `dist/client` plus the Worker and an **output** `wrangler.json`; `wrangler deploy` and `vite preview` use that output file automatically.
- `assets` options: `directory`, `binding`, `run_worker_first` (`boolean | string[]`, default `false`), `html_handling` (`"auto-trailing-slash" | "force-trailing-slash" | "drop-trailing-slash" | "none"`), `not_found_handling` (`"single-page-application" | "404-page" | "none"`, default `"none"`).
- `run_worker_first` patterns must begin with `/` or `!/`, support `*` globs and `!` exceptions, max 100 entries. Array form needs Wrangler >= 4.20.0 and Vite plugin >= 1.7.0.
- Default routing: a request that matches an asset is served without invoking the Worker. With `not_found_handling` set and compatibility date >= 2025-04-01, a navigation request (`Sec-Fetch-Mode: navigate`) that matches no asset gets `index.html` and does **not** invoke the Worker — browsing to `/api/x` returns HTML; a non-navigation request that matches no asset invokes the Worker.
- A path listed in `run_worker_first` always invokes the Worker first, navigation or not; a `!` pattern always goes to asset serving. List every Worker-handled prefix explicitly (for example `/api/*`, `/agents/*`) rather than relying on header detection (see Could not verify).
- `run_worker_first: true` runs the Worker before every request; it then serves assets through the binding: `await this.env.ASSETS.fetch(request)`.
- Requests are billed only when the Worker script is invoked.
- Smart Placement with `run_worker_first` places the whole Worker as one unit (documented limitation).
- Wrangler config fields ignored under the Vite plugin: `tsconfig`, `rules`, `build`, `no_bundle`, `find_additional_modules`, `base_dir`, `preserve_file_names`; `define`, `alias`, `minify` and dev-server settings move to Vite config. `.sql`, `.txt`, `.html` import as `string` without configuration. Sources: https://developers.cloudflare.com/workers/vite-plugin/reference/migrating-from-wrangler-dev/ · https://developers.cloudflare.com/workers/vite-plugin/reference/non-javascript-modules/
- Environments are applied at build time: `CLOUDFLARE_ENV=some-env vite build`, not `wrangler deploy --env`.
- Local state defaults to `.wrangler/state` (`persistState` option). `.gitignore`: `.wrangler`, `.dev.vars*`. Source: https://developers.cloudflare.com/workers/vite-plugin/reference/api/
- Scaffold: `npm create cloudflare@latest -- my-react-app --framework=react`. Source: https://developers.cloudflare.com/workers/framework-guides/web-apps/react/

**Access and static assets.** Source: https://developers.cloudflare.com/workers/configuration/cloudflare-access/#ctxaccess-limitations

> Workers with Static Assets execute behind an internal router Worker. Access still protects the application and its assets. However, the router does not pass `ctx.access` to the user Worker.

`ctx.access` is also not propagated through Service Binding fetches or RPC. Without assets, the API is `ctx.access` (`undefined` when Access did not authenticate), `ctx.access.aud`, `await ctx.access.getIdentity()`. Local simulation:

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

**`cloudflare.config.ts`.** Sources: https://developers.cloudflare.com/cf/projects/cloudflare-config/ · https://developers.cloudflare.com/cf/projects/ · https://developers.cloudflare.com/cf/wrangler/ · https://developers.cloudflare.com/cf/

- Status: "open beta. The configuration format can change before the stable release." The `cf` CLI itself is beta.
- Read by `cf dev` / `cf build` / `cf deploy`, which use `@cloudflare/vite-plugin@beta` (2.0 beta, no Wrangler dependency) or Wrangler >= 4.136.0. "Wrangler does not read `cloudflare.config.ts`."
- Requires Node.js >= 22.18, `"type": "module"`, not Bun.
- Running `cf dev`, `cf build` or `cf deploy` in an unmigrated Wrangler project triggers automatic configuration that writes a new `cloudflare.config.ts` ignoring the Wrangler file and edits `package.json`; in CI it does so without asking.
- Not yet covered by `cf`: live log tailing, setting a single secret. `cf migrate` leaves Durable Object migrations, Workflows and Containers as manual work.
- Shape, for when it stabilises (`cf` 1.0.0-beta.11; docs example with two entries omitted):

```ts
import { defineConfig, exports } from "cf/config";
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };

export default defineConfig({
	worker: {
		name: "example-worker",
		entrypoint,
		compatibilityDate: "<COMPATIBILITY_DATE>",
		exports: {
			default: exports.worker({ cache: { enabled: false } }),
			Counter: exports.durableObject({ storage: "sqlite" }),
			OrderWorkflow: exports.workflow({
				name: "order-workflow",
				limits: { steps: 100 },
			}),
		},
	},
});
```

- Useful later: builds write a deployable Build Output to `.cloudflare/output/v0/`, and `cf deploy --prebuilt --mode production` deploys it without building.

Recommendation: a new project should use `wrangler.jsonc` today. Every stable tool in this note (Wrangler, Vite plugin 1.x, the Vitest plugin, `createTestHarness`) takes a Wrangler config path.

### Workflows

Sources: https://developers.cloudflare.com/workflows/build/workers-api/ · https://developers.cloudflare.com/workflows/build/sleeping-and-retrying/ · https://developers.cloudflare.com/workflows/build/rules-of-workflows/ · https://developers.cloudflare.com/workflows/build/events-and-parameters/ · typings `@cloudflare/workers-types` 5.20261002.1

Definition:

```ts
import { WorkflowEntrypoint, WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";

export class MyWorkflow extends WorkflowEntrypoint<Env, Params> {
	async run(event: WorkflowEvent<Params>, step: WorkflowStep) {
		// Steps here
	}
}
```

```ts
export type WorkflowEvent<T> = {
	payload: Readonly<T>;
	timestamp: Date;
	instanceId: string;
	workflowName: string;
	schedule?: WorkflowCronSchedule;
};
```

Step API (typings, abridged: two further `do` overloads narrow the context type by the kind of `retries.delay`; `WorkflowStepContext` shown as documented):

```ts
export abstract class WorkflowStep {
  do<T extends Rpc.Serializable<T>>(
    name: string,
    callback: (ctx: WorkflowStepContext) => Promise<T>,
    rollbackOptions?: WorkflowStepRollbackOptions<T>,
  ): Promise<T>;
  do<T extends Rpc.Serializable<T>>(
    name: string,
    config: WorkflowStepConfig,
    callback: (ctx: WorkflowStepContext) => Promise<T>,
    rollbackOptions?: WorkflowStepRollbackOptions<T>,
  ): Promise<T>;
  sleep: (name: string, duration: WorkflowSleepDuration) => Promise<void>;
  sleepUntil: (name: string, timestamp: Date | number) => Promise<void>;
  waitForEvent<T extends Rpc.Serializable<T>>(
    name: string,
    options: {
      type: string;
      timeout?: WorkflowTimeoutDuration | number;
    },
  ): Promise<WorkflowStepEvent<T>>;
}

export type WorkflowStepConfig = {
  retries?: {
    limit: number;
    delay: WorkflowDelayDuration | number | WorkflowDelayFunction;
    backoff?: WorkflowBackoff; // "constant" | "linear" | "exponential"
  };
  timeout?: WorkflowTimeoutDuration | number;
  sensitive?: WorkflowStepSensitivity; // "output"
};

export type WorkflowStepContext = {
	step: { name: string; count: number };
	attempt: number;
	config: WorkflowStepConfig;
};
```

- Durations are a number of milliseconds or `` `${number} ${"second"|"minute"|"hour"|"day"|"week"|"month"|"year"}` `` with optional `s`.
- Defaults when no config is given:

```ts
const defaultConfig: WorkflowStepConfig = {
	retries: {
		limit: 5,
		delay: 10000,
		backoff: "exponential",
	},
	timeout: "10 minutes",
};
```

- `timeout` is per attempt. Docs advise step timeouts of 30 minutes or less and `waitForEvent` for longer waits.
- `throw new NonRetryableError(message)` stops retries; uncaught, it fails the instance. A `try/catch` around `step.do` lets the Workflow continue.
- `waitForEvent` default timeout is 24 hours; `type` is up to 100 characters matching `^[a-zA-Z0-9_][a-zA-Z0-9-_]*$`. An event sent before the instance reaches the matching `waitForEvent` is buffered and delivered.
- Step names are the cache key: they must be deterministic, and state must be built only from step return values (in-memory state is lost when the engine hibernates).
- **Parallel steps:** `await Promise.all([step.do("a", …), step.do("b", …)])` is the documented pattern. `Promise.race()` / `Promise.any()` over steps must be wrapped in an outer `step.do()` or the cached winner can differ on replay.
- Step return values must be serializable and at most 1 MiB; a step may instead return a fresh `ReadableStream<Uint8Array>` for larger binary output (counts toward instance storage).
- Rollback: a final `{ rollback, rollbackConfig }` argument to `step.do` registers a compensating handler, run in reverse step-start order when the instance fails.

Instance API (typings):

```ts
declare abstract class WorkflowInstance {
  public id: string;
  public pause(): Promise<void>;
  public resume(): Promise<void>;
  public terminate(options?: WorkflowInstanceTerminateOptions): Promise<void>;
  public restart(options?: WorkflowInstanceRestartOptions): Promise<void>;
  public delete(): Promise<void>;
  public status(): Promise<InstanceStatus>;
  public sendEvent({ type, payload }: { type: string; payload: unknown }): Promise<void>;
  public subscribe(
    options?: WorkflowInstanceSubscribeOptions,
  ): Promise<WorkflowInstanceSubscription>;
}
```

- Binding methods: `create(options?: WorkflowInstanceCreateOptions)`, `createBatch(batch)` (up to 100, idempotent — existing IDs are skipped), `deleteBatch(instanceIds)` (1–100), `get(id)` (throws if unknown).
- `create({ id })` throws if the ID is already used by an instance still inside its retention period; `restart()` re-runs an existing instance, optionally `restart({ from: { name, count?, type? } })` to reuse earlier step results.
- `InstanceStatus.status`: `"queued" | "running" | "paused" | "errored" | "terminated" | "complete" | "waiting" | "waitingForPause" | "unknown"`.

**Config and `ctx.exports`.** Sources: https://developers.cloudflare.com/workflows/build/workers-api/#declare-workflows-in-exports · https://developers.cloudflare.com/workers/runtime-apis/context/#exports

Binding form:

```jsonc
{
	"workflows": [
		{
			"name": "workflows-starter",
			"binding": "MY_WORKFLOW",
			"class_name": "MyWorkflow"
		}
	]
}
```

Export form (Wrangler >= 4.139.0):

```jsonc
{
	"exports": {
		"MyWorkflow": {
			"type": "workflow",
			"name": "billing-workflow",
			"schedules": ["0 * * * *"]
		}
	}
}
```

```ts
const instance = await ctx.exports.MyWorkflow.create({
	params: { name: "World" },
});
const existing = await ctx.exports.MyWorkflow.get(id);
```

- Keyed by class name; same API as a Workflow binding. Local support needs Wrangler >= 4.142.0, `@cloudflare/vite-plugin` >= 1.61.0, `@cloudflare/vitest-plugin` >= 1.3.0. `wrangler types` (>= 4.142.0) types it as `Workflow<Params>`.
- A Workflow may be declared as both binding and export (same class, no conflicting settings); instances are shared by `name`. Workflow names are unique per account, max 64 characters.
- Workflow entries in `exports` may coexist with a Durable Object `migrations` array.
- `ctx.exports` is on by default from compatibility date 2025-11-17 (`enable_ctx_exports`); it is also available as `this.ctx.exports` inside a Durable Object. Source: https://developers.cloudflare.com/workers/configuration/compatibility-flags/
- Optional settings on either form: `limits.steps`, `schedules`, `default_retention` (`success_retention`, `error_retention`).

**`.subscribe()` (released 2026-09-15).** Sources: https://developers.cloudflare.com/workflows/build/subscribe-to-instance-events/ · https://developers.cloudflare.com/changelog/post/2026-09-15-instance-event-subscriptions/

```ts
type WorkflowInstanceSubscribeOptions = {
  /** The value from which to start the subscription. */
  cursor?: number;
  /** The event types to include in the subscription. */
  filter?: WorkflowInstanceEventType[];
};
interface WorkflowInstanceSubscription extends Disposable {
  next(): Promise<IteratorResult<WorkflowInstanceEvent, void>>;
}
```

```ts
using subscription = await instance.subscribe();

while (true) {
	const result = await subscription.next();
	if (result.done) {
		break;
	}
	console.log(result.value.type, result.value);
}
```

- `cursor` is an `eventId`: the subscription starts with the first event whose `eventId` is greater. `filter` limits `next()` to the listed types.
- Delivers the full recorded history first, then live events. Ends on `workflow_completed`, `workflow_errored` or `workflow_terminated`, even if the filter excludes them (`next()` then returns `done: true`).
- Every event has `instanceId`, `eventId: number`, `timestamp: number` and a `type`. Types: `workflow_queued|started|running|paused|waiting_for_pause|waiting|completed|errored|terminated`; `step_started|completed|errored` (`stepName`); `attempt_started|completed|errored` (`stepName`, `attempt`); `sleep_started|completed`; `wait_started|completed|timed_out`; `rollback_*`. `step_completed` carries `output` unless the step is `sensitive: "output"`, in which case it is `"[REDACTED]"`.
- The subscription "holds a Workers RPC resource": declare with `using` or call `subscription[Symbol.dispose]()`.
- Subscriptions remain available for the instance retention period. There is also a REST `GET /subscribe` endpoint.
- **Browser use:** the docs describe Worker and HTTP-API consumers only. To reach a browser, a Worker fetch handler can loop `next()` into a streamed (SSE) response — an HTTP invocation has no wall-time limit while the client stays connected — or a Durable Object can relay over WebSockets. Resume after a disconnect with `cursor`. Neither pattern is shown in the docs.

**Limits (Workers Paid).** Source: https://developers.cloudflare.com/workflows/reference/limits/

| | |
| --- | --- |
| CPU per step | 30 s default, configurable to 5 min (`limits.cpu_ms`) |
| Wall time per step | unlimited |
| Step result (non-stream) / event payload | 1 MiB each |
| Persisted state per instance | 1 GB |
| Steps per instance | 10,000 default, up to 25,000 (`limits.steps`); `step.sleep` does not count |
| Retries per step | 10,000 |
| `step.sleep` maximum | 365 days |
| Concurrent running instances per account | 50,000 (table; prose on the same page says 10,000) — `waiting` instances do not count |
| Instance creation rate | 300/s per account, 100/s per Workflow (429 above) |
| Subrequests per instance | 10,000 default, up to 10M (`limits.subrequests`) |
| Retention of finished instance state | 30 days |
| Instance ID | 100 characters |

Pricing (Paid): Workers CPU/request pricing, plus 1 GB-month storage included then $0.20/GB-month, 500,000 steps/month included then $0.80 per 100,000. Retries and rollback handlers are not counted as steps. Source: https://developers.cloudflare.com/workflows/reference/pricing/

### Durable Objects

**Declaring classes.** Sources: https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/ · https://developers.cloudflare.com/changelog/post/2026-06-30-declarative-do-class-exports/ · https://developers.cloudflare.com/workers/wrangler/configuration/#durable-objects

Current (declarative):

```jsonc
{
	"durable_objects": {
		"bindings": [
			{
				"name": "MY_DURABLE_OBJECT",
				"class_name": "MyDurableObject",
			},
		],
	},
	"exports": {
		"MyDurableObject": {
			"type": "durable-object",
			"storage": "sqlite",
		},
	},
}
```

Legacy (still supported, used by Agents SDK and Drizzle docs):

```jsonc
{
	"migrations": [
		{ "tag": "v1", "new_sqlite_classes": ["ChatRoom"] }
	]
}
```

- `exports` entry fields: `type: "durable-object"`, `state` (`"created"` default, `"deleted"`, `"renamed"`, `"transferred"`, `"expecting-transfer"`), `storage` (`"sqlite"`; `"legacy-kv"` only for existing namespaces), `renamed_to`, `transferred_to`, `transfer_from`, `container`.
- Durable Object entries in `exports` and `migrations` are mutually exclusive in one Worker. "Once a Worker has been deployed with `exports`, subsequent deploys cannot return to the legacy `migrations` array."
- Lifecycle changes apply only through `wrangler deploy`. `wrangler versions upload` fails when the config has `exports` entries; gradual deployments are not supported with `exports`; rollbacks cannot cross a lifecycle change.
- A `deleted` tombstone removes the namespace and all its data permanently. Storage backend is immutable once provisioned.
- New key-value-backed namespaces can no longer be created (2026-07-09); SQLite is the only backend for new classes.
- A binding is only needed for `env` access; a live class is also reachable as `ctx.exports.ClassName` (`idFromName`, `get`, …).
- `config-schema.json` in Wrangler 4.147.0 contains `exports`; the docs give no minimum Wrangler version for Durable Object entries.

**SQLite storage API.** Source: https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/

```ts
import { DurableObject } from "cloudflare:workers";

export class MyDurableObject extends DurableObject {
  sql: SqlStorage;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
  }
}
```

- ``exec(query: string, ...bindings: any[]): SqlStorageCursor`` — synchronous. Multiple `;`-separated statements allowed; bindings apply to the last one, and the cursor is for the last one.
- Cursor: iterable; `next()`, `toArray()`, `one()` (throws unless exactly one row), `raw()`, `columnNames`, `rowsRead`, `rowsWritten`. Consume it before the next `await` — a cursor held across `await` has no snapshot isolation.
- `sql.exec()` cannot run `BEGIN`/`SAVEPOINT`. Use `ctx.storage.transactionSync(callback)` (callback must be synchronous) or `ctx.storage.transaction(async (txn) => …)`. Writes with no intervening `await` are already atomic.
- `ctx.storage.sql.databaseSize` — bytes.
- Synchronous KV on SQLite-backed objects: `ctx.storage.kv.get(key)`, `.put(key, value)`, `.delete(key)`, `.list(options?)`. Async `ctx.storage.get/put/delete/list` also work.
- Extensions: FTS5, JSON, math functions.
- Point-in-time recovery (30 days): `getCurrentBookmark()`, `getBookmarkForTime(timestamp)`, `onNextSessionRestoreBookmark(bookmark)` then `ctx.abort()`. Not available in local development.
- `deleteAll()` also deletes the alarm from compatibility date 2026-02-24.
- Numeric columns are read as JavaScript numbers (int64 precision loss).

**Alarms.** Source: https://developers.cloudflare.com/durable-objects/api/alarms/

- One alarm per object: `ctx.storage.setAlarm(scheduledTime: number | Date)`, `getAlarm(): Promise<number | null>`, `deleteAlarm()`. Handler: `alarm(alarmInfo?: { retryCount: number; isRetry: boolean })`.
- At-least-once; on an uncaught exception retried with exponential backoff from 2 s, up to 6 retries. Catch inside the handler and reschedule if work must not be dropped. Handler wall-time limit 15 minutes.
- In a constructor, check `getAlarm()` before `setAlarm()`: the constructor runs before `alarm()` on wake.

**WebSocket hibernation.** Sources: https://developers.cloudflare.com/durable-objects/best-practices/websockets/ · typings

```ts
import { DurableObject } from "cloudflare:workers";

// Durable Object
export class WebSocketHibernationServer extends DurableObject {
	async fetch(request: Request): Promise<Response> {
		// Creates two ends of a WebSocket connection.
		const webSocketPair = new WebSocketPair();
		const [client, server] = Object.values(webSocketPair);

		// Unlike `ws.accept()`, `state.acceptWebSocket(ws)` allows the Durable Object to be hibernated
		this.ctx.acceptWebSocket(server);

		return new Response(null, {
			status: 101,
			webSocket: client,
		});
	}

	async webSocketMessage(ws: WebSocket, message: ArrayBuffer | string) {
		ws.send(
			`[Durable Object] message: ${message}, connections: ${this.ctx.getWebSockets().length}`,
		);
	}

	async webSocketClose(
		ws: WebSocket,
		code: number,
		reason: string,
		wasClean: boolean,
	) {
		ws.close(code, reason);
	}
}
```

```ts
// DurableObjectState
acceptWebSocket(ws: WebSocket, tags?: string[]): void;
getWebSockets(tag?: string): WebSocket[];
setWebSocketAutoResponse(maybeReqResp?: WebSocketRequestResponsePair): void;
getTags(ws: WebSocket): string[];
```

- Clients stay connected while the object is evicted from memory; duration is not billed during hibernation. On the next event the constructor runs again and in-memory state is gone.
- Per-connection state: `ws.serializeAttachment(value)` (structured-clone, max 16,384 bytes) and `ws.deserializeAttachment()`.
- Protocol pings are answered by the runtime without waking the object. From compatibility date 2026-04-07 the runtime auto-replies to Close frames.
- `setTimeout`/`setInterval`, in-flight requests, unfinished I/O, open outbound connections and the standard `ws.accept()` API all prevent hibernation.
- Hibernation happens after about 10 seconds idle; a non-hibernatable idle object is evicted after 70–140 seconds. Source: https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/
- "Code updates disconnect all WebSockets" — every deploy restarts every object. Clients must reconnect and re-fetch.
- The Worker should validate the upgrade request and authorisation before forwarding to the object (`stub.fetch(request)`); `env.NS.getByName("name")` returns a stub directly.
- Received WebSocket message limit 32 MiB. Incoming messages are billed at a 20:1 ratio; outgoing messages are free.

**RPC.** Source: https://developers.cloudflare.com/durable-objects/best-practices/create-durable-object-stubs-and-send-requests/

- Public methods on a class extending `DurableObject` are callable on the stub: `await stub.method(args)`. Each call is one RPC session and one billed request. Returned non-primitive values should be held with `using`.
- Wall time for RPC/HTTP into an object is unlimited while the caller stays connected.
- From compatibility date 2026-10-01 (`durable_object_io_tasks_prevent_eviction`), pending service-binding requests, DO-to-DO RPC/fetch, `ctx.waitUntil()` promises and timers keep an object alive without a connected client, each for up to 15 minutes from its start. Duration is billed meanwhile. Source: https://developers.cloudflare.com/changelog/post/2026-10-01-pending-io-keep-alive/
- There are no shutdown hooks; persist progress incrementally.

**Limits (SQLite-backed, Paid).** Source: https://developers.cloudflare.com/durable-objects/platform/limits/

| | |
| --- | --- |
| Storage per object | 10 GB (then `SQLITE_FULL` on writes; reads and deletes still work) |
| Row / string / BLOB | 2 MB |
| Columns per table | 100 |
| SQL statement length | 100 KB |
| Bound parameters per query | 100 |
| `LIKE` / `GLOB` pattern | 50 bytes |
| CPU per request | 30 s, reset by each incoming request or WebSocket message; configurable to 5 min |
| Throughput | soft limit about 1,000 requests/s per object |
| Classes per account | 500 |

Pricing (Paid): requests 1M/month included then $0.15/M; duration 400,000 GB-s included then $12.50/M GB-s; SQL rows read 25B/month included then $0.001/M; rows written 50M/month included then $1.00/M; storage 5 GB-month included then $0.20/GB-month. Each `setAlarm()` is one row written. Source: https://developers.cloudflare.com/durable-objects/platform/pricing/

**Primitive for pushing live status to browsers watching one change:** a Durable Object addressed by change ID, accepting browser connections with the Hibernation WebSocket API and broadcasting with `this.ctx.getWebSockets()`; producers (Workflow steps, queue consumers, API handlers) call it over RPC. This is the pattern the docs recommend for many clients on one entity, and it costs nothing while idle. The Agents SDK `Agent` class is this primitive with state sync and client reconnection already built (next section).

### Agents SDK

Sources: https://developers.cloudflare.com/agents/ · https://developers.cloudflare.com/agents/communication-channels/chat/chat-agents/ · https://developers.cloudflare.com/agents/communication-channels/chat/client-sdk/ · https://developers.cloudflare.com/agents/runtime/communication/routing/ · https://developers.cloudflare.com/agents/runtime/lifecycle/state/ · https://developers.cloudflare.com/agents/runtime/execution/sub-agents/ · https://developers.cloudflare.com/agents/harnesses/think/ · typings `agents` 0.25.0, `@cloudflare/ai-chat` 0.12.1

Packages: `agents` (runtime, React bindings at `agents/react`, client at `agents/client`, Vite plugin at `agents/vite`), `@cloudflare/ai-chat` (`AIChatAgent`, `useAgentChat`), `@cloudflare/think` (opinionated harness, parts marked experimental).

`Agent` (typings, abridged) — a `DurableObject` subclass:

```ts
declare class Agent<
  Env extends Cloudflare.Env = Cloudflare.Env,
  TState = unknown,
  Props extends object = object
> extends DurableObject<Env> {
  initialState: TState;
  get state(): TState;
  setState(state: TState): void;
  sql<T = Record<string, string | number | boolean | null>>(
    strings: TemplateStringsArray,
    ...values: (string | number | boolean | null)[]
  ): T[];
  onStart(_props?: Props): void | Promise<void>;
  onRequest(_request: Request): Response | Promise<Response>;
  onConnect(_connection: Connection, _context: ConnectionContext): void | Promise<void>;
  onMessage(_connection: Connection, _message: WSMessage): void | Promise<void>;
  onClose(_connection: Connection, _code: number, _reason: string, _wasClean: boolean): void | Promise<void>;
  validateStateChange(_nextState: TState, _source: Connection | "server"): void;
  onStateChanged(_state: TState | undefined, _source: Connection | "server"): void;
  broadcast(msg: string | ArrayBuffer | ArrayBufferView, without?: string[]): void;
  schedule<T = string>(when: Date | string | number, callback: keyof this, payload?: T, options?: ScheduleOptions): Promise<Schedule<T>>;
  subAgent<T extends Agent>(cls: DynamicAgentClass<T>, name: string): Promise<DynamicAgentStub<T>>;
  static options: AgentStaticOptions; // hibernate: true by default
}
```

Wiring (docs):

```ts
import { routeAgentRequest } from "agents";
export { CounterAgent } from "./agents/counter";

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext) {
		const agentResponse = await routeAgentRequest(request, env);
		if (agentResponse) return agentResponse;
		return new Response("Not found", { status: 404 });
	},
} satisfies ExportedHandler<Env>;
```

```jsonc
{
	"durable_objects": {
		"bindings": [{ "name": "ChatAgent", "class_name": "ChatAgent" }],
	},
	"migrations": [{ "tag": "v1", "new_sqlite_classes": ["ChatAgent"] }],
}
```

- URL scheme used by `routeAgentRequest` and the clients: `/agents/{kebab-case-class}/{instance-name}` (a client-side `basePath` plus server-side `getAgentByName` can replace it).
- Typings: `routeAgentRequest(request, env, options?): Promise<Response | null>` (docs say `undefined`). Options include `onBeforeConnect(request)` and `onBeforeRequest(request)` — return a `Response` to reject — plus `props`, `cors`, `locationHint`, `jurisdiction`.
- Server-side access: `const stub = await getAgentByName(env.Counter, "name")`, then plain RPC.
- `nodejs_compat` is required (default from compatibility date 2026-08-04). `@callable()` needs TC39 decorators: `"extends": "agents/tsconfig"` in `tsconfig.json` and `agents()` from `agents/vite` in the Vite plugins.
- **State sync:** `setState()` persists and broadcasts to every connected client; clients may push state with `agent.setState()`, gated by `validateStateChange`. `shouldConnectionBeReadonly` / `setConnectionReadonly` exist for read-only connections. Docs advise keeping state small and using `this.sql` for larger data.
- Limits: 30 s CPU refreshed per request or message; the Agents page states 1 GB state per agent, while the underlying SQLite object limit is 10 GB. Source: https://developers.cloudflare.com/agents/platform/limits/

Client:

```ts
import { useAgent } from "agents/react";

const agent = useAgent({
	agent: "ChatAgent",
	name: "room-123",
	onStateUpdate: (state) => {},
});
const response = await agent.call("sendMessage", ["Hello!"]);
```

- `useAgent` options: `agent`, `name` (default `"default"`), `host`, `path`, `basePath`, `query` (object or async function, re-run on reconnect), `sub`, `onStateUpdate(state, source)`, `onOpen`, `onClose`, `onError`. Reconnects automatically with backoff. `agent.state` is `undefined` until the first server message. `agent.stub.method(...)` is typed with `useAgent<MyAgent>`.
- Non-React: `AgentClient` from `agents/client`; `agentFetch` for one-off HTTP.

Chat agent:

```ts
import { AIChatAgent } from "@cloudflare/ai-chat";
import { createWorkersAI } from "workers-ai-provider";
import { streamText, convertToModelMessages } from "ai";

export class ChatAgent extends AIChatAgent {
	async onChatMessage() {
		const workersai = createWorkersAI({ binding: this.env.AI });

		const result = streamText({
			model: workersai("@cf/zai-org/glm-4.7-flash"),
			messages: await convertToModelMessages(this.messages),
		});

		return result.toUIMessageStreamResponse();
	}
}
```

```ts
import { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/ai-chat/react";

const agent = useAgent({ agent: "ChatAgent" });
const { messages, sendMessage, status } = useAgentChat({ agent });
```

```ts
// typings
onChatMessage(
  _onFinish: GenerateTextOnFinishCallback<ToolSet>,
  _options?: OnChatMessageOptions
): Promise<Response | undefined>;
```

- `this.messages` is `UIMessage[]` (AI SDK) loaded from the object's SQLite; messages persist automatically. `maxPersistedMessages` caps storage by deleting the oldest. Messages approaching the 2 MB row limit are compacted from about 1.8 MB.
- Streaming goes over the agent WebSocket. Chunks are buffered in SQLite; a client that reconnects resumes mid-stream (`resume: true` default). Other connected clients receive the final messages as a broadcast.
- A Durable Object eviction mid-turn is recovered automatically (always on; tune with `chatRecovery`, hook `onChatRecovery`).
- Server-driven turns: `persistMessages(messages)` stores and broadcasts without a model turn; `saveMessages(messages | (messages) => messages)` stores and runs `onChatMessage`, returning `{ requestId, status }`; `onChatResponse(result)` fires after a turn is persisted.
- Tools use the AI SDK `tool()`: with `execute` they run on the server; without it the client handles them in `onToolCall`; `needsApproval` pauses for `addToolApprovalResponse({ id, approved })`. Use `stopWhen: stepCountIs(n)` for multi-step loops. Forward `options.abortSignal` to `streamText` or a cancelled turn keeps running.
- `useAgentChat` returns `messages`, `sendMessage`, `clearHistory`, `addToolOutput`, `addToolApprovalResponse`, `setMessages`, `status` (`"ready" | "submitted" | "streaming" | "error"`), `isStreaming`, `isServerStreaming`, `isToolContinuation`, `isRecovering`, `stop`.
- `messageConcurrency`: `"queue"` (default), `"latest"`, `"merge"`, `"drop"`, `{ strategy: "debounce" }`.
- Any AI SDK provider works; the model call is entirely in `onChatMessage`.

Sub-agents (facets):

```ts
const chat = await this.subAgent(Chat, chatId); // inside the parent

const chat = useAgent({
	agent: "Inbox",
	name: userId,
	sub: [{ agent: "Chat", name: chatId }],
}); // → /agents/inbox/{userId}/sub/chat/{chatId}
```

- A child is a co-located Durable Object with its own isolated SQLite database. Only the top-level parent needs a binding and class declaration; children are found through `ctx.exports` and must be exported under their class name.
- The parent can gate access with `onBeforeSubAgent`, list with `listSubAgents`, delete with `deleteSubAgent`. A child reaches its parent with `await this.parentAgent(ParentClass)`.
- From outside: `getSubAgentByName(parentStub, Chat, chatId)` (RPC only).

Workflows from an agent — `AgentWorkflow` from `agents/workflows`: `this.reportProgress(…)`, `this.broadcastToClients(message)`, `this.agent.<method>()` over RPC, and on the agent `runWorkflow(name, params)`, `onWorkflowProgress`, `onWorkflowComplete`. "Workflows cannot open WebSocket connections directly." Source: https://developers.cloudflare.com/agents/runtime/execution/run-workflows/

`AIChatAgent` vs Think: both speak the same WebSocket chat protocol. `AIChatAgent` is a protocol adapter where the model call is yours; Think owns the loop, adds tree-structured sessions, memory blocks, compaction, FTS5 search and workspace tools, and needs `@cloudflare/shell` as well.

**Fit for a conversational thread per review comment.** It fits: one `AIChatAgent` instance per comment thread gives a durable transcript, streamed replies to every viewer, resume on reconnect, server tools for "resolve" and "act", approval gates, and `saveMessages()` for the review agent's opening comment. With sub-agents, one parent per change can own its comment threads (and hold the change's live status as agent state) with a single binding. A plain Durable Object would have to reimplement stream buffering and resume, the tool-continuation protocol, multi-client broadcast and eviction recovery. It is heavier in three ways that the design must contain: the packages are pre-1.0 and were published on the day of this check; the peer set is large (`ai` v6/v7, `zod ^4`, `react ^19`, `@ai-sdk/react`); and transcripts live in per-thread SQLite, so anything the forge must query across threads (comment status, resolution, classification) has to be written through to the relational store by the agent. Think is more than this use needs.

### Queues

Sources: https://developers.cloudflare.com/queues/configuration/configure-queues/ · https://developers.cloudflare.com/queues/configuration/batching-retries/ · https://developers.cloudflare.com/queues/configuration/dead-letter-queues/ · https://developers.cloudflare.com/queues/configuration/javascript-apis/ · https://developers.cloudflare.com/queues/platform/limits/ · https://developers.cloudflare.com/queues/reference/delivery-guarantees/

```jsonc
{
	"queues": {
		"producers": [
			{ "queue": "my-queue", "binding": "MY_QUEUE" }
		],
		"consumers": [
			{
				"queue": "my-queue",
				"max_batch_size": 10,
				"max_batch_timeout": 30,
				"max_retries": 10,
				"dead_letter_queue": "my-queue-dlq"
			}
		]
	}
}
```

- Consumer defaults: `max_batch_size` 10 (1–100), `max_batch_timeout` 5 s (0–60), `max_retries` 3 (max 100), optional `max_concurrency`, `retry_delay` (seconds). Producer option `delivery_delay`.
- One Worker can be producer and consumer.

```ts
export default {
	async queue(batch, env, ctx): Promise<void> {
		for (const msg of batch.messages) {
			// TODO: do something with the message
			// Explicitly acknowledge the message as delivered
			msg.ack();
		}
	},
} satisfies ExportedHandler<Env>;
```

Type the body with `Queue<T>` on the producer and `satisfies ExportedHandler<Env, T>` on the consumer; untyped, `message.body` is `unknown`.

```ts
interface MessageBatch<Body = unknown> {
  readonly queue: string;
  readonly messages: readonly Message<Body>[];
  ackAll(): void;
  retryAll(options?: QueueRetryOptions): void;
}
// Message: id, timestamp, body, attempts, ack(), retry(options?)
interface Queue<Body = unknown> {
  send(body: Body, options?: QueueSendOptions): Promise<QueueSendResult>;
  sendBatch(messages: Iterable<MessageSendRequest<Body>>, options?: QueueSendBatchOptions): Promise<QueueSendResult>;
  metrics(): Promise<QueueMetrics>;
}
```

- The batch is acknowledged when `queue()` returns, its promise resolves and all `waitUntil()` promises resolve. If the handler throws, **the whole batch is retried** except messages already `ack()`ed. First call wins between `ack()` and `retry()` on a message; per-message calls take precedence over `ackAll()`/`retryAll()`.
- `msg.retry({ delaySeconds })` and `batch.retryAll({ delaySeconds })`; delays up to 24 hours (also `send(body, { delaySeconds })`). `msg.attempts` supports backoff.
- After `max_retries` a message goes to `dead_letter_queue` if configured (created automatically if missing), otherwise it is deleted. A DLQ is an ordinary queue and needs its own consumer; unconsumed DLQ messages persist 4 days.
- Delivery is at least once; ordering within a batch is best effort.
- Limits: message 128 KB; `sendBatch` 100 messages or 256 KB; 5,000 messages/s per queue; retention default 4 days, up to 14; backlog 25 GB; 250 concurrent consumer invocations; consumer wall time 15 minutes; consumer CPU 30 s, configurable to 5 minutes.
- Default content type is `json`; `Date`, `Map` and similar need `contentType: "v8"`.

**Event subscriptions.** Sources: https://developers.cloudflare.com/queues/event-subscriptions/ · https://developers.cloudflare.com/queues/event-subscriptions/manage-event-subscriptions/ · https://developers.cloudflare.com/queues/event-subscriptions/events-schemas/

```bash
npx wrangler queues subscription create <queue-name> --source <source-type> --events <event1,event2> --<source-specific-option> <value>
npx wrangler queues subscription list <queue-name>
npx wrangler queues subscription delete <queue-name> --id <subscription-id>
```

- Events arrive as ordinary queue messages; `message.body` is the event. Common fields: `type`, `source`, `payload`, `metadata.accountId`, `metadata.eventSubscriptionId`, `metadata.eventSchemaVersion`, `metadata.eventTimestamp`.
- Documented sources: Access, Artifacts, Browser Run, Email Sending, R2, Super Slurper, Vectorize, Workers AI, Workers Builds, Workers KV, Workflows.
- Artifacts push, as documented:

```json
{
  "type": "cf.artifacts.repo.pushed",
  "source": {
    "type": "artifacts.repo",
    "namespace": "my-namespace",
    "repoName": "my-repo"
  },
  "payload": {
    "ref": "refs/heads/main",
    "before": "abc123def456abc123def456abc123def456abc1",
    "after": "def789ghi012def789ghi012def789ghi012def7",
    "commits": [
      {
        "id": "def789ghi012def789ghi012def789ghi012def7",
        "message": "Fix bug in authentication",
        "messageTruncated": false,
        "timestamp": "2025-05-01T02:48:57.000Z",
        "author": { "name": "Developer Name", "email": "developer@example.com" },
        "committer": { "name": "Developer Name", "email": "developer@example.com" },
        "parents": ["abc123def456abc123def456abc123def456abc1"]
      }
    ],
    "totalCommitsCount": 1,
    "commitsTruncated": false
  },
  "metadata": {
    "accountId": "f9f79265f388666de8122cfb508d7776",
    "eventSubscriptionId": "1830c4bb612e43c3af7f4cada31fbf3f",
    "eventSchemaVersion": 1,
    "eventTimestamp": "2025-05-01T02:48:57.132Z"
  }
}
```

- The documented `pushed` payload has no field identifying the token or user that pushed. `commits` can be truncated (`commitsTruncated`, `messageTruncated`), so the consumer must be able to read the range itself.
- Workflows also publish `cf.workflows.workflow.instance.{queued,started,paused,errored,terminated,completed}` with `payload.instanceId`.

### D1

Sources: https://developers.cloudflare.com/d1/platform/limits/ · https://developers.cloudflare.com/d1/platform/pricing/ · https://developers.cloudflare.com/d1/reference/migrations/ · https://developers.cloudflare.com/d1/wrangler-commands/ · https://developers.cloudflare.com/d1/best-practices/local-development/ · https://developers.cloudflare.com/d1/best-practices/read-replication/ · https://developers.cloudflare.com/d1/worker-api/d1-database/

Limits (Workers Paid):

| | |
| --- | --- |
| Database size | 10 GB, cannot be increased |
| Databases per account | 50,000 |
| Queries per Worker invocation | 1,000 |
| Simultaneous connections per invocation | 6 |
| Row / string / BLOB | 2 MB |
| Columns per table | 100 |
| SQL statement length | 100 KB (per statement inside a batch) |
| Bound parameters per query | 100 |
| `LIKE` / `GLOB` pattern | 50 bytes |
| Query duration | 30 s (applies to a whole `batch()` call) |
| Time Travel | 30 days; 10 restores per 10 minutes |

- A database is single-threaded and backed by one Durable Object: throughput is about `1 / average query duration`; overload returns an "overloaded" error.
- Pricing (Paid): rows read 25B/month included then $0.001/M; rows written 50M/month included then $1.00/M; storage 5 GB included then $0.75/GB-month. An indexed write counts an extra row per index.

Binding and migrations config:

```jsonc
{
	"d1_databases": [
		{
			"binding": "<BINDING_NAME>",
			"database_name": "<DATABASE_NAME>",
			"database_id": "<UUID>",
			"preview_database_id": "<UUID>",
			"migrations_table": "<d1_migrations>",
			"migrations_dir": "<FOLDER_NAME>",
			"migrations_pattern": "<GLOB>"
		}
	]
}
```

```sh
npx wrangler d1 migrations create <DATABASE> <MESSAGE>
npx wrangler d1 migrations list <DATABASE>      # --local | --remote
npx wrangler d1 migrations apply <DATABASE>     # --local | --remote | --preview | --persist-to <dir>
```

- Migrations are `.sql` files in `migrations/` by default; applied ones are recorded in `d1_migrations`. Prefer the database name over the binding name on the command line.
- `migrations_pattern` exists for ORMs that write one directory per migration (the docs name Drizzle: `"migrations_pattern": "migrations/*/migration.sql"`); it requires `migrations_dir` and must start with it.
- Use `PRAGMA defer_foreign_keys = true` in a migration that temporarily violates foreign keys.

Worker API (typings):

```ts
declare abstract class D1Database {
  prepare(query: string): D1PreparedStatement;
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
  exec(query: string): Promise<D1ExecResult>;
  withSession(constraintOrBookmark?: D1SessionBookmark | D1SessionConstraint): D1DatabaseSession;
}
// D1PreparedStatement: bind(...values), first(colName?), run(), all(), raw(options?)
// D1DatabaseSession: prepare(), batch(), getBookmark(): D1SessionBookmark | null
```

- `batch()` is the transaction primitive: "Batched statements are SQL transactions"; a failing statement rolls back the whole sequence. There is no interactive transaction across awaits.
- **Read replication / Sessions API:** `env.DB.withSession()` (same as `"first-unconstrained"`), `withSession("first-primary")`, or `withSession(bookmark)`; `session.getBookmark()` gives the value to carry to the next request. Without the Sessions API every query goes to the primary. Replication is enabled per database, costs nothing extra, and gives sequential consistency within a session. For a single-organisation deployment it is optional; using `withSession("first-primary")` from the start keeps the door open at no cost.

Local persistence: local D1 is a separate, initially empty database under `.wrangler/state`, persisted across `wrangler dev` / `vite dev` runs; `"remote": true` on the binding connects to the real database instead. Apply migrations locally with `wrangler d1 migrations apply <DATABASE> --local`.

**Drizzle.** Sources: https://orm.drizzle.team/docs/get-started/d1-new · https://orm.drizzle.team/docs/get-started/do-new (read from the docs repository, `drizzle-team/drizzle-orm-docs`, `main`)

D1 (`drizzle-orm` 0.45.3, `drizzle-kit` 0.31.11):

```typescript
import { drizzle } from 'drizzle-orm/d1';

const db = drizzle(env.<BINDING_NAME>);
const result = await db.select().from(users).all()
```

```typescript
import 'dotenv/config';
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  out: './drizzle',
  schema: './src/db/schema.ts',
  dialect: 'sqlite',
  driver: 'd1-http',
  dbCredentials: {
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID!,
    databaseId: process.env.CLOUDFLARE_DATABASE_ID!,
    token: process.env.CLOUDFLARE_D1_TOKEN!,
  },
});
```

- The Drizzle guide points Wrangler at Drizzle's output with `migrations_dir = "drizzle"`, so the workflow is `npx drizzle-kit generate` → `wrangler d1 migrations apply <DATABASE> --local|--remote`. The `d1-http` credentials are for drizzle-kit commands that talk to the remote database.

Durable Object SQLite:

```ts
import { drizzle, DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite';
import { DurableObject } from 'cloudflare:workers'
import { migrate } from 'drizzle-orm/durable-sqlite/migrator';
import migrations from '../drizzle/migrations';

export class MyDurableObject extends DurableObject {
	storage: DurableObjectStorage;
	db: DrizzleSqliteDODatabase<any>;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.storage = ctx.storage;
		this.db = drizzle(this.storage, { logger: false });

		// Make sure all migrations complete before accepting queries.
		// Otherwise you will need to run `this.migrate()` in any function
		// that accesses the Drizzle database `this.db`.
		ctx.blockConcurrencyWhile(async () => {
			await this._migrate();
		});
	}

	async _migrate() {
		migrate(this.db, migrations);
	}
}
```

- drizzle-kit config for it: `dialect: 'sqlite', driver: 'durable-sqlite'`. Migrations are bundled into the Worker and run inside each object ("You can apply migrations only from Cloudflare Workers"). The Drizzle guide adds a Wrangler `[[rules]] type = "Text" globs = ["**/*.sql"]` block; under the Vite plugin `rules` is ignored and `.sql` already imports as a string.

**D1 or SQLite-in-Durable-Objects for the forge's relational records.** Use **D1** for records that are queried across entities — changes, sections, comments, approvals, the decision index. Cloudflare's own comparison (https://developers.cloudflare.com/workers/platform/storage-options/#sql-in-durable-objects-vs-d1) states that query pricing and limits are intended to be identical, and that the difference is tooling and topology:

| | D1 | SQLite in a Durable Object |
| --- | --- | --- |
| Access | Worker binding and HTTP API; `wrangler d1 execute`, dashboard | Only from inside that object's class |
| Schema migrations | `wrangler d1 migrations`, applied once per database, before or after deploy | Run in code in every object's constructor; old and new objects coexist |
| Cross-entity queries | Ordinary SQL | Not possible across objects; one "global" object reintroduces a single-threaded database without D1's tooling |
| Recovery | Time Travel, 30 days, CLI | PITR bookmarks, 30 days, in code, not available locally |
| Transactions | `batch()` only | Synchronous `transactionSync`, and code runs next to the data with no network hop |
| Test support | `applyD1Migrations`, `readD1Migrations` | `runInDurableObject` |
| Storage price | $0.75/GB-month | $0.20/GB-month |
| Read replicas | Sessions API | None |

The cost of D1 is a network hop per query (1,000 per invocation), `batch()`-only transactions, and a hard 10 GB cap per database. Keep Durable Object SQLite for state owned by one object: a change's live status and connections, and a comment thread's transcript.

### Testing

Sources: https://developers.cloudflare.com/workers/testing/ · https://developers.cloudflare.com/workers/testing/vitest-integration/ · https://developers.cloudflare.com/workers/testing/vitest-integration/migration-guides/migrate-to-vitest-plugin/ · https://developers.cloudflare.com/workers/testing/vitest-integration/configuration/ · https://developers.cloudflare.com/workers/testing/vitest-integration/test-apis/ · https://developers.cloudflare.com/workers/testing/vitest-integration/known-issues/ · https://developers.cloudflare.com/workers/testing/test-harness/

- "`@cloudflare/vitest-plugin` replaces `@cloudflare/vitest-pool-workers`. The package API and Vitest configuration are unchanged." `@cloudflare/vitest-pool-workers` is still on npm at 0.22.0 (last published 2026-09-18) and is not marked deprecated there. Codemod: `npx @cloudflare/codemods vitest:pool-workers-to-vitest-plugin`.
- Install: `npm i -D vitest@^4.1.0 @cloudflare/vitest-plugin`.

```ts
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
	plugins: [
		cloudflareTest({
			wrangler: { configPath: "./wrangler.jsonc" },
		}),
	],
});
```

```jsonc
// test/tsconfig.json
{
	"extends": "../tsconfig.json",
	"compilerOptions": {
		"moduleResolution": "bundler",
		"types": ["@cloudflare/vitest-plugin/types"]
	},
	"include": ["./**/*.ts", "../src/worker-configuration.d.ts"]
}
```

- `CloudflareTestOptions`: `main`, `miniflare` (overrides; takes precedence over the Wrangler file), `wrangler: { configPath?, environment? }`, `additionalExports` (`{ Name: "WorkerEntrypoint" | "DurableObject" | "WorkflowEntrypoint" }` for exports esbuild cannot infer).
- Tests run inside `workerd`. `import { env, exports } from "cloudflare:workers"`; `exports.default.fetch(url)` drives the Worker's default handler in the same isolate as the test.
- `cloudflare:test` exports:
  - Events: `createExecutionContext()`, `waitOnExecutionContext(ctx)`, `createScheduledController(options?)`, `createMessageBatch(queueName, messages)`, `getQueueResult(batch, ctx)`.
  - Durable Objects: `runInDurableObject(stub, (instance, state) => …)`, `runDurableObjectAlarm(stub)`, `evictDurableObject(stub, options?)`, `evictAllDurableObjects(options?)`, `abortAllDurableObjects()`, `listDurableObjectIds(namespace)`, `reset()`.
  - D1: `applyD1Migrations(db, migrations, migrationTableName?)`; `readD1Migrations(migrationsPath)` runs in the Node-side config and is passed in as a test-only binding.
  - Workflows: `introspectWorkflowInstance(workflow, instanceId)`, `introspectWorkflow(workflow)`; modifiers `disableSleeps`, `disableRetryDelays`, `mockStepResult`, `mockStepError`, `forceStepTimeout`, `mockEvent`, `forceEventTimeout`; assertions `waitForStepResult`, `waitForStatus`, `getOutput`, `getError`. Dispose every introspector (`await using`).
- Workflow introspection needs a binding from `env`; it throws for a Workflow taken from `ctx.exports`. For a Workflow declared only in `exports`, add a test-only binding:

```ts
cloudflareTest({
	wrangler: { configPath: "./wrangler.jsonc" },
	miniflare: {
		workflows: {
			MY_WORKFLOW: { name: "my-workflow", className: "MyWorkflow" },
		},
	},
}),
```

- Queues are exercised at handler level: build a batch, call `worker.queue(batch, env, ctx)`, inspect `getQueueResult` (`ackAll`, `retryBatch`, `explicitAcks`, `retryMessages`).
- What it cannot do:
  - Static assets: "`exports` does not expose Assets." Use `createTestHarness()` (or `startDevWorker()`).
  - "Using WebSockets with Durable Objects is not supported with per-file storage isolation" — run those files with `--max-workers=1 --no-isolate`.
  - No native V8 coverage (use Istanbul). No custom Vitest `environment` or `runner`. Fake timers do not affect KV, R2 or cache simulators.
  - Dynamic `import()` inside handlers and Durable Object event handlers does not work with `exports.default.fetch()`.
  - It injects `nodejs_compat` when the config has no Node.js compatibility flag, so a Node.js import can pass tests and fail deploy on an older compatibility date.
  - Sub-agent (facet) classes may need test-only Durable Object bindings. Source: https://developers.cloudflare.com/agents/runtime/execution/sub-agents/#notes-for-testing
- Storage isolation is per test file, and writes are undone at the end of the file. Always `await` storage operations and consume response bodies.

`createTestHarness()` (exported from `wrangler`; present in 4.147.0 typings) — integration tests against **built** output from any Node.js test runner:

```ts
import { createTestHarness } from "wrangler";

const server = createTestHarness({
	workers: [{ configPath: "./wrangler.jsonc" }],
});

beforeAll(async () => { await server.listen(); });
afterEach(async () => { await server.reset(); });
afterAll(async () => { await server.close(); });

const response = await server.fetch("/");
```

- For a Vite-plugin project run `vite build` first and point `configPath` at the generated output config (docs example: `./dist/web_worker/wrangler.json`).
- Per-worker `vars`, `secrets`, `env`; `server.getWorker(name)` → `.fetch()`, `.scheduled({ cron, scheduledTime })`, `.introspectWorkflow(bindingName)`; `server.getLogs()`, `server.clearLogs()`, `server.debug()`. `server.reset()` recreates storage, so re-apply migrations and seed data after it. Documented integrations: MSW and Playwright.

### Worker limits and baseline config

Sources: https://developers.cloudflare.com/workers/platform/limits/ · https://developers.cloudflare.com/workers/wrangler/configuration/#limits · https://developers.cloudflare.com/workers/configuration/compatibility-dates/ · https://developers.cloudflare.com/workers/configuration/compatibility-flags/

| Limit (Workers Paid) | Value |
| --- | --- |
| CPU time per HTTP request | 30 s default, up to 5 min (`limits.cpu_ms`, max 300000) |
| CPU per Cron Trigger | 30 s (interval < 1 h), 15 min (>= 1 h) |
| Wall time, HTTP | no limit while the client is connected; `waitUntil()` extends 30 s past the response |
| Wall time, cron / queue consumer / DO alarm | 15 min |
| Memory per isolate | 128 MB |
| Subrequests per invocation | 10,000 default, up to 10M (`limits.subrequests`) |
| Simultaneous connections awaiting headers | 6 |
| Worker size | 64 MiB uncompressed (Free and Paid); no compressed limit |
| Startup time | 1 s for global scope |
| Environment variables | 128 per Worker, 5 KB each |
| Static asset files per version | 100,000 (Wrangler >= 4.34.0); 25 MiB per file |
| Workers per account | 500 |
| Cron Triggers per account | 250 |
| Request body | set by zone plan: 100 MB on Free/Pro |

```jsonc
{
	"limits": {
		"cpu_ms": 300000,
		"subrequests": 150
	}
}
```

- `limits` are "only enforced when deployed to Cloudflare's network, not in local development."
- Check size with `wrangler deploy --outdir bundled/ --dry-run` (the `Total Upload` figure).
- The Workers memory section tells Zod users to be on 4.5.0 or later (earlier versions use much more memory per schema).
- The runtime is updated a few times per week; in-flight requests get a 30-second grace period.

Compatibility settings for a project created today:

- `"compatibility_date": "2026-10-02"`. Docs: "you should always set `compatibility_date` to the current date."
- No flags are required by anything in this note at that date:
  - `nodejs_compat` + `nodejs_compat_v2` are default from 2026-08-04; docs say to omit them from new configurations.
  - `enable_ctx_exports` default from 2025-11-17.
  - `durable_object_io_tasks_prevent_eviction` default from 2026-10-01.
  - `web_socket_auto_reply_to_close` default from 2026-04-07.
  - `delete_all_deletes_alarm` default from 2026-02-24.
  - `assets_navigation_prefers_asset_serving` default from 2025-04-01 (opt out with `assets_navigation_has_no_effect`).
- Generate types with `wrangler types` rather than installing `@cloudflare/workers-types`; re-run after every binding change. It also types `ctx.exports`.

## Local development and tests

Works locally under `vite dev` / `wrangler dev` (Miniflare 5, `workerd`), no account needed:

- Worker code, static asset routing (the Vite plugin applies `assets` routing in dev as in production), D1, Durable Objects including SQLite storage, alarms and hibernatable WebSocket handlers, Queues (producer and consumer in one process), Workflows (emulated), `ctx.exports`.
- State persists under `.wrangler/state` between runs.
- `wrangler workflows … --local` (Wrangler >= 4.79.0) and the Local Explorer at `/cdn-cgi/local/explorer` (Wrangler >= 4.82.1 or Vite plugin >= 1.32.0) inspect, trigger, pause and send events to local Workflow instances.
- `ctx.access` can be simulated with the `access.dev` config block.
- D1 migrations: `wrangler d1 migrations apply <DATABASE> --local`.

Works under `@cloudflare/vitest-plugin` (runs in `workerd`, per-file isolated storage): D1 with migrations, Durable Objects (direct instance access, alarms, eviction), queue handlers via constructed batches, Workflows via introspection with mocked steps, events and sleeps.

Needs `createTestHarness()` or a browser-level test instead: static asset serving and SPA fallback, `run_worker_first` routing, Durable Object WebSockets (or run those Vitest files non-isolated), multi-Worker routing.

Needs Docker: nothing in this note. (Containers and Sandbox do; they are covered elsewhere.)

Cannot run locally — put behind a port and fake it:

- **Workers AI / AI bindings** always execute remotely, so they need credentials and network. Source: https://developers.cloudflare.com/workers/local-development/
- **Cloudflare Access enforcement** — only the simulated identity block exists locally.
- **Event-subscription delivery** — no local emitter is documented. Tests build the documented envelope and pass it to the queue handler.
- **Durable Object point-in-time recovery** — "not supported in local development".
- **`limits` (CPU, subrequests)** are not enforced locally; **queue consumer concurrency** is not supported locally.
- **Remote bindings** are unsupported for Durable Objects and Workflows (they always run locally); Workflows and Queues do not support `wrangler dev --remote`.
- **Browser Run** has no local simulation (`remote: true` recommended).

Differences to remember: local Workflows are "an emulated version of Workflows compared to the one that Cloudflare runs globally"; WebSocket hibernation is emulated locally since wrangler 3.13.2 / Miniflare 3.20231016.0, and tests can force it with `evictDurableObject()`.

## Could not verify

- **Whether the Access JWT header still reaches a Worker that has static assets.** The docs state only that `ctx.access` is not passed. Whether `Cf-Access-Jwt-Assertion` (or the `CF_Authorization` cookie) arrives at the user Worker, and whether `run_worker_first: true` changes anything, is not stated on the Workers pages read. Tried: the Workers Access page, the static-assets routing pages, the Vite plugin static-assets page. Needs a deployed test or the Zero Trust docs.
- **Routing of unlisted paths when `run_worker_first` is an array.** The SPA page says the array form "disables the automatic `Sec-Fetch-Mode: navigate` detection", while the routing diagram on the same page still shows the navigation check for requests that match neither the array nor an asset. Whether a navigation to an unlisted, non-asset path reaches the Worker under the array form was not tested.
- **Whether `access.dev` produces `ctx.access` locally for a Worker with assets.** Not stated.
- **Minimum Wrangler version for Durable Object entries in `exports`.** The Workflow export page gives 4.139.0; the Durable Object page gives none. The 4.147.0 config schema contains the field. Feature announced 2026-07-04 (changelog slug dated 2026-06-30).
- **Agents SDK with Durable Object `exports` instead of `migrations`.** Every Agents and Drizzle example uses `migrations` / `new_sqlite_classes`, and the sub-agent page words its requirements in those terms. Nothing says `exports` fails; nothing shows it working. Not executed.
- **`@cloudflare/vitest-plugin` and `createTestHarness()` with `cloudflare.config.ts`.** Docs show only Wrangler config paths.
- **`.subscribe()` in local development and in the Vitest plugin.** Neither docs page mentions it. The Miniflare 5.20261001.0-alpha bundle contains a `subscribe(options)` implementation in its Workflows binding (found by searching the published package), but it was not run.
- **How long a subscription may be held, and backpressure.** No limits are documented for a subscription held open by a fetch handler or Durable Object. A Durable Object holding one without a connected client falls under the 15-minute pending-I/O rule; whether a pending `next()` counts as such an operation is not stated.
- **Workflows concurrency figure.** The limits table says 50,000 concurrent instances (matching the 2026-04-15 changelog); the prose below it still says 10,000. The same page lists "3MB / 10MB" script size while the Workers limits page says 64 MiB for both plans; the Agents limits page repeats 10 MB. The Workers limits page (updated 2026-09-05) is the newest.
- **Agents limits.** The Agents page says 1 GB state per agent; the Durable Objects page says 10 GB per SQLite object. The `AgentWorkflow` page lists "State size 10 MB per workflow" and "30 minutes per step", which do not match the Workflows limits page (1 GB, unlimited wall time).
- **`routeAgentRequest` return value.** Docs say `Promise<Response | undefined>`; `agents` 0.25.0 typings say `Promise<Response | null>`. Treat as falsy.
- **`@cloudflare/vitest-plugin/config` subpath.** The docs say `readD1Migrations` and `buildPagesASSETSBinding` are exported from it, but their own examples import from the package root, and the 1.3.6 `package.json` exports only `.` and `./types`. Import from the root.
- **Drizzle migration layout with Wrangler.** The Drizzle D1 guide implies flat `.sql` files in `./drizzle` consumed via `migrations_dir`; Cloudflare's D1 docs describe a nested Drizzle layout needing `migrations_pattern`. Which one `drizzle-kit` 0.31.11 emits (versus the 1.0 release candidates) was not run. Also not confirmed from a primary source: that `drizzle-kit generate` works for D1 with no `driver`/credentials. The Drizzle "connect" reference pages were not retrievable as source; only the two get-started guides were read.
- **`sensitive: "output"` step config.** Present in the typings and referenced in the subscribe docs; no dedicated documentation was found.
- **Local emission of event-subscription messages.** No documentation either way.
- **Vitest 5 support.** The plugin's peer range is `^4.1.0`; no statement on Vitest 5 was found.
- Nothing in this note was run. Version requirements and behaviours are as documented on 2026-10-02.
