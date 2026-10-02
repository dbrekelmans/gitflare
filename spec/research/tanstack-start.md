# TanStack Start on Workers

Verified 2026-10-02 against live docs.

Method: Cloudflare pages were fetched as markdown (`developers.cloudflare.com/<path>/index.md`); TanStack's docs were read from the `TanStack/router` repository (`docs/start/framework/react/**`, `docs/router/**`, `main` at commit `1f0f20a`); shadcn's from `ui.shadcn.com/docs/<page>.md`; signatures were cross-checked against the installed packages. Unlike the other notes in this directory, part of this one **was run locally**: a minimal Start app with a custom server entry, one Durable Object, one Workflow and a D1 binding was built, served with `vite dev`, and tested with the Workers Vitest plugin. Those facts are marked _(observed locally)_. Nothing was deployed and no Cloudflare account was used.

Package versions read and installed (npm `latest` on 2026-10-02):

| Package | Version | Note |
| --- | --- | --- |
| `@tanstack/react-start` | 1.168.60 | `engines.node >= 22.12.0`; peers `vite >= 7`, `react >= 18` |
| `@tanstack/react-router` | 1.170.41 | |
| `@tanstack/react-query` | 5.104.1 | |
| `@tanstack/react-router-ssr-query` | 1.167.3 | peers `@tanstack/react-query >= 5.102.0`, `@tanstack/react-router >= 1.170.33` |
| `@tanstack/react-form` | 1.33.5 | |
| `@cloudflare/vite-plugin` | 1.62.5 | |
| `wrangler` | 4.147.0 | |
| `@cloudflare/vitest-plugin` | 1.3.6 | peers `vitest ^4.1.0` |
| `vitest` | 4.1.11 | `latest` is 5.0.3, outside the plugin's range |
| `vite` | 8.3.2 | |
| `shadcn` (CLI) | 4.21.1 | |

## What this forces

- **The Worker entry is a file we own, `src/server.ts`, and it is the only place Durable Object and Workflow classes can be exported.** It imports Start's handler, re-exports the classes by name, and default-exports `{ fetch }` (plus `queue`/`scheduled` if needed). `wrangler.jsonc` `main` points at it. Every class a build task adds must already be exported there, so the scaffold has to export a stub for each one up front.
- **Bindings are read with `import { env } from "cloudflare:workers"`, not from a handler argument.** Server functions, server routes and middleware receive no `env`. Any module that imports `cloudflare:workers` cannot be imported by a Node test, so the composition root that touches `env` must be one small module and everything behind it must take its dependencies as arguments.
- **Server functions are for the app; server routes are for everyone else.** TanStack's docs say so in both guides: server functions are same-origin RPC with a CSRF check and generated ids, not a stable HTTP API. The CLI, the git credential helper and the WebSocket endpoint therefore need server routes with paths we choose.
- **`validator`, not `inputValidator`.** In 1.168.60 `.inputValidator()` is typed `@deprecated Use validator instead`; Cloudflare's guide still shows both spellings on one page.
- **A WebSocket upgrade can go through a server route.** Returning `stub.fetch(request)` from a `GET` handler delivered a working hibernatable WebSocket in local dev _(observed locally)_. No doc states it, so the entry-point intercept stays as the fallback.
- **The real Start entry cannot be loaded by the Workers Vitest plugin.** It fails resolving Start's virtual modules _(observed locally)_. Durable Objects, Workflows and D1 are testable under the plugin through a separate test entry that exports only those classes; server functions are not, so their bodies must be one-line calls into plain functions that are tested in Node.
- **`ctx.access` is still unavailable, and Cloudflare now names TanStack Start in that limitation.** A Start app on Workers always has static assets (the client bundle). Identity has to come from validating the Access JWT ourselves; whether the header reaches the Worker is still untested (see Could not verify).
- **Worker-level Access still rejects WebSocket upgrades with `403`.** Nothing about the framework changes it: use a hostname-based Access application.
- **`routeTree.gen.ts` is generated and is meant to be committed.** It changes whenever a route file is added, removed or renamed, which makes it a merge-conflict point for parallel work. Create every route file before the parallel phase.
- **shadcn's monorepo layout puts components in the UI package and imports them by deep path** (`@scope/ui/components/button`), with the app's `components.json` pointing its `ui` and `utils` aliases and its `tailwind.css` at the package.

## Verified facts

### Project shape

Sources: https://developers.cloudflare.com/workers/framework-guides/web-apps/tanstack-start/ (last updated 2026-09-04) · https://tanstack.com/start/latest/docs/framework/react/guide/hosting

`vite.config.ts`, identical on both pages:

```ts
import { defineConfig } from "vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";

export default defineConfig({
	plugins: [
		cloudflare({ viteEnvironment: { name: "ssr" } }),
		tanstackStart(),
		react(),
	],
});
```

`wrangler.jsonc` (Cloudflare's page):

```jsonc
{
	"$schema": "node_modules/wrangler/config-schema.json",
	"name": "<YOUR_PROJECT_NAME>",
	// Set this to today's date
	"compatibility_date": "2026-10-02",
	"compatibility_flags": ["nodejs_compat"],
	"main": "@tanstack/react-start/server-entry",
	"observability": {
		"enabled": true,
	},
}
```

- Scripts: `"dev": "vite dev"`, `"build": "vite build"`, `"preview": "vite preview"`, `"deploy": "npm run build && wrangler deploy"`, `"cf-typegen": "wrangler types"`.
- Scaffold: `npm create cloudflare@latest -- my-tanstack-start-app --framework=tanstack-start`.
- The guide keeps `"compatibility_flags": ["nodejs_compat"]` although `spec/research/platform.md` records the flag as default from 2026-08-04. Keeping it is harmless.
- Start is published as 1.x (`latest` 1.168.60); the hosting page calls Cloudflare an "Official Hosting Partner" and says "The official Cloudflare Workers setup currently uses Vite through `@cloudflare/vite-plugin`."
- Build output _(observed locally)_: `vite build` writes `dist/client/` (assets) and `dist/server/` (`index.js`, chunks, and an output `wrangler.json`). The output config has `"main": "index.js"`, `"no_bundle": true`, `"assets": { "directory": "../client" }` — added by the plugin although the input config declares no `assets` — and carries `durable_objects`, `exports`, `workflows`, `d1_databases`, `vars` and `triggers` through unchanged.
- Static prerendering exists (`tanstackStart({ prerender: { enabled: true } })`, needs `@tanstack/react-start` >= 1.138.0); it runs at build time against local bindings. Not needed here.

### The server entry: Durable Objects, Workflows, other handlers

Source: https://developers.cloudflare.com/workers/framework-guides/web-apps/tanstack-start/#custom-entrypoints

> TanStack Start uses `@tanstack/react-start/server-entry` as your default entrypoint. Create a custom server entrypoint to add additional Workers handlers such as Queues and Cron Triggers. This is also where you can add additional exports such as Durable Objects and Workflows.

```ts
// src/server.ts
import handler from "@tanstack/react-start/server-entry";

// Export Durable Objects as named exports
export { MyDurableObject } from "./my-durable-object";

export default {
	fetch: handler.fetch,

	// Handle Queue messages
	async queue(batch, env, ctx) {
		for (const message of batch.messages) {
			console.log("Processing message:", message.body);
			message.ack();
		}
	},

	// Handle Cron Triggers
	async scheduled(event, env, ctx) {
		console.log("Cron triggered:", event.cron);
	},
};
```

```jsonc
{
	"main": "src/server.ts",
}
```

- Workflows: "Export a Workflow class from your custom entrypoint", declared with the ordinary `workflows: [{ name, binding, class_name }]` block.
- TanStack's own page (https://tanstack.com/start/latest/docs/framework/react/guide/server-entry-point) shows the same file with a typed wrapper and a way to pass per-request context into Start:

```tsx
import handler, { createServerEntry } from '@tanstack/react-start/server-entry'

type MyRequestContext = {
  hello: string
  foo: number
}

declare module '@tanstack/react-router' {
  interface Register {
    server: {
      requestContext: MyRequestContext
    }
  }
}

export default createServerEntry({
  async fetch(request) {
    return handler.fetch(request, { context: { hello: 'world', foo: 123 } })
  },
})
```

  "The registered context is delivered as the second argument to the server `fetch` handler and is available throughout the server-side middleware chain — including global middleware, request/function middleware, server routes, server functions, and the router itself."
- _(observed locally)_ An entry that re-exports one `DurableObject` subclass and one `WorkflowEntrypoint` subclass builds, and the built `dist/server/index.js` ends with `export { ChangePipelineWorkflow, ChangeRoom, worker_entry_default as default }`.
- _(observed locally)_ Declaring the Durable Object the current way — a `durable_objects.bindings` entry plus `"exports": { "ChangeRoom": { "type": "durable-object", "storage": "sqlite" } }`, no `migrations` — works under `vite dev`, `vite build` and the Vitest plugin. Workflows were declared in binding form.
- `wrangler types` _(observed locally)_ resolves the classes through the entry: `CHANGE_ROOM: DurableObjectNamespace<import("./src/server").ChangeRoom>` and `CHANGE_PIPELINE: Workflow<Parameters<import("./src/server").ChangePipelineWorkflow['run']>[0]['payload']>`, so RPC methods and Workflow params are typed at call sites. It runs offline.

### Bindings, request and context

Sources: the Cloudflare guide, "Bindings" · https://tanstack.com/start/latest/docs/framework/react/guide/server-functions

```ts
import { createServerFn } from "@tanstack/react-start";
import { env } from "cloudflare:workers";

const getData = createServerFn().handler(() => {
	// Access bindings via env
	// For example: env.MY_KV, env.MY_BUCKET, env.AI, etc.
});
```

- Types come from `wrangler types` (the `cf-typegen` script), which writes `worker-configuration.d.ts`.
- Request access inside a server function, from `@tanstack/react-start/server`: `getRequest()`, `getRequestHeader(name)`, `setResponseHeader(name, value)`, `setResponseHeaders(headers)`, `setResponseStatus(code)`; `getCookie` is used in the Query guide.
- A server route handler receives `{ request, params, context }`.
- _(observed locally)_ A server function that runs `env.DB.prepare("select 1 as one").first()` and reads `getRequestHeader("user-agent")` returns both during SSR under `vite dev`, with local D1.
- Neither guide shows how to reach the `ExecutionContext`. The custom entry receives it as the third `fetch` argument and can forward it through `handler.fetch(request, { context })`; `waitUntil` is also importable from `cloudflare:workers` (see `spec/research/platform.md` for `ctx.exports`). Not exercised here.

### Server functions

Source: https://tanstack.com/start/latest/docs/framework/react/guide/server-functions · typings `@tanstack/start-client-core` 1.170.34 (`createServerFn.d.ts`)

```tsx
import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'

const UserSchema = z.object({
  name: z.string().min(1),
  age: z.number().min(0),
})

export const createUser = createServerFn({ method: 'POST' })
  .validator(UserSchema)
  .handler(async ({ data }) => {
    // data is fully typed and validated
    return `Created user: ${data.name}, age ${data.age}`
  })
```

- Method defaults to `GET`. Called as `await createUser({ data: { … } })`.
- Typings: `validator: ValidatorFn<…>` and `/** @deprecated Use validator instead. */ inputValidator: ValidatorFn<…>`. Cloudflare's guide uses `.inputValidator` in one example and `.validator` in another.
- "Server functions are same-origin RPC endpoints for your application." Start installs `createCsrfMiddleware()` automatically unless the app defines `src/start.ts`, in which case it must be added explicitly. Requests lacking all of `Sec-Fetch-Site`, `Origin` and `Referer` are rejected by default.
- "If you need an endpoint that can be called from outside your Start app, use server routes instead."
- Inputs and outputs are type-checked for serializability (`strict` mode, default); `Response` return values are allowed.
- Errors thrown in a handler are serialized to the caller; `throw redirect({ to })` and `throw notFound()` (from `@tanstack/react-router`) are "handled automatically when called from route lifecycles or components using `useServerFn()`".
- Server functions "can be statically imported in any file, including client components"; the build replaces the implementation with an RPC stub. Dynamic `import()` of a server-function module "can cause bundler issues".
- Suggested file split: `*.functions.ts` (the `createServerFn` wrappers, importable anywhere), `*.server.ts` (server-only helpers, imported only inside handlers), plain `.ts` for client-safe schemas and types.
- "Server functions are API endpoints reachable independently of whichever route renders the calling UI. Apply `authMiddleware` or an equivalent in-handler check to every server function that reads or writes private data. `beforeLoad` is useful route UX, but it is not the data boundary."
- Function ids are SHA-256 hashes generated at build; a `generateFunctionId` option exists and is marked experimental.

### Server routes

Source: https://tanstack.com/start/latest/docs/framework/react/guide/server-routes

```ts
// routes/hello.ts
import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/hello')({
  server: {
    middleware: [authMiddleware, loggerMiddleware], // Applies to all handlers
    handlers: {
      GET: async ({ request }) => {
        return new Response('Hello, World! from ' + request.url)
      },
      POST: async ({ request }) => {
        const body = await request.json()
        return new Response(`Hello, ${body.name}!`)
      },
    },
  },
})
```

- Server routes live in `src/routes` beside app routes and use the same file conventions: `routes/api/file/$.ts` → `/api/file/$` (splat in `params._splat`), `routes/users/$id.ts` → `params.id`. One file per path; a file may hold both a `server` block and a `component`.
- Per-method middleware uses `handlers: ({ createHandlers }) => createHandlers({ GET: { middleware: [...], handler } })`.
- Handlers return a `Response` (`Response.json(...)` is shown).

### Middleware

Source: https://tanstack.com/start/latest/docs/framework/react/guide/middleware

```tsx
import { createMiddleware } from '@tanstack/react-start'

const awesomeMiddleware = createMiddleware({ type: 'function' }).server(
  ({ next }) => {
    return next({
      context: {
        isAwesome: Math.random() > 0.5,
      },
    })
  },
)
```

- Two kinds. Request middleware (`createMiddleware()`, the default type) has `.server(({ next, context, request }) => …)` and applies to server routes, SSR and server functions. Server-function middleware (`createMiddleware({ type: 'function' })`) adds `.client()` and `.validator()`, and may depend on request middleware (not the reverse).
- Context added through `next({ context })` is merged and typed for everything downstream, including the server function's `handler({ context })`.
- A server function attaches middleware with `createServerFn().middleware([…])`.
- Global middleware is declared in `src/start.ts` with `createStart(() => ({ requestMiddleware: […] }))`. That file "is not included in the default TanStack Start template"; creating it turns the automatic CSRF middleware off unless it is listed.

### Routing conventions that matter for parallel work

Sources: https://tanstack.com/start/latest/docs/framework/react/guide/routing · https://tanstack.com/router/latest/docs/framework/react/routing/file-naming-conventions · https://tanstack.com/router/latest/docs/framework/react/faq

- `src/router.tsx` must export `getRouter()`, "a function that returns a new router instance each time". `src/routes/__root.tsx` renders the document (`<html>`, `<HeadContent />`, `<Scripts />`).
- `routeTree.gen.ts` "is automatically generated when you run TanStack Start (via `npm run dev` or `npm run start`)". _(observed locally)_ `vite build` also writes it. FAQ: "Should I commit my `routeTree.gen.ts` file into git? Yes! … it is essentially part of your application's runtime, not a build artifact." The file header asks for it to be excluded from linters and formatters.
- "The path string passed to `createFileRoute` is automatically written and managed by the router".
- File naming: `.` separates nested segments (`blog.post`); `$` marks a param; a `_` prefix makes a pathless layout route; a `_` suffix un-nests a route; **files and folders with a `-` prefix "are excluded from the route tree" and "can be used to colocate logic in route folders"**; `(folder)` is a route group that does not appear in the URL; `index` matches the parent path exactly; `route.tsx` inside a directory is that directory's route file.

### TanStack Query

Source: https://tanstack.com/start/latest/docs/framework/react/guide/tanstack-query

```tsx
// src/router.tsx
import { QueryClient } from '@tanstack/react-query'
import { createRouter } from '@tanstack/react-router'
import { setupRouterSsrQueryIntegration } from '@tanstack/react-router-ssr-query'
import { routeTree } from './routeTree.gen'

export function getRouter() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { staleTime: 30_000 } },
  })
  const router = createRouter({
    routeTree,
    context: { queryClient },
    defaultPreload: 'intent',
    defaultPreloadStaleTime: 0,
  })

  setupRouterSsrQueryIntegration({ router, queryClient })
  return router
}
```

- "Create the client inside `getRouter`, not at module scope. Start creates a router for each SSR request. A process-wide QueryClient could reuse one reader's cached data in another reader's HTML."
- The root route declares the context type with `createRootRouteWithContext<{ queryClient: QueryClient }>()`. "The integration supplies the Query provider and handles SSR dehydration, hydration, and streaming. Do not add a second QueryClient".
- One `queryOptions` object is shared by the loader and the component:

```tsx
export const readerNameOptions = queryOptions({
  queryKey: ['reader-name'],
  queryFn: () => getReaderName(),
})

export const Route = createFileRoute('/preferences')({
  loader: async ({ context }) => {
    await context.queryClient.query(readerNameOptions)
  },
  component: Preferences,
})

function Preferences() {
  const { data: name } = useSuspenseQuery(readerNameOptions)
  return <p>Hello, {name}</p>
}
```

  The guide uses `queryClient.query(...)` ("Query 5.102 or newer"); `ensureQueryData` is the older equivalent and worked in the local run.
- "Privileged reads belong in a server function, because a normal route loader can also run in the browser during navigation."
- Mutations: `const save = useServerFn(saveReaderName)` then `useMutation({ mutationFn: (name: string) => save({ data: name }), onSuccess: () => queryClient.invalidateQueries({ queryKey: readerNameOptions.queryKey }) })`. "`queryClient.invalidateQueries` refreshes Query data; `router.invalidate()` reloads Router-owned loader data and route context. Use both only when the mutation changes both".
- "A plain `useQuery` that has no loader prefetch is not a guarantee that its data will be in the server-rendered HTML."
- _(observed locally)_ With this setup the SSR response contains the rendered data and a dehydrated query cache; no second QueryClient or provider was written.

### WebSocket upgrade to a Durable Object

No page read documents WebSockets in a Start app. _(observed locally, `vite dev`, the versions above)_:

```ts
// src/routes/api/live.$id.ts
export const Route = createFileRoute("/api/live/$id")({
  server: {
    handlers: {
      GET: ({ request, params }) => {
        if (request.headers.get("upgrade") !== "websocket") {
          return new Response("expected websocket", { status: 426 });
        }
        return env.CHANGE_ROOM.getByName(params.id).fetch(request);
      },
    },
  },
});
```

With a Durable Object that calls `this.ctx.acceptWebSocket(server)` and returns `new Response(null, { status: 101, webSocket: client })`, a Node `WebSocket` client connected, received a message sent on accept, and got its echo from `webSocketMessage`. So Start's handler passes a `101` response with a `webSocket` through unchanged in local dev. Not verified on a deployed Worker.

Fallback that does not depend on Start: match the path in `src/server.ts` and return `stub.fetch(request)` before calling `handler.fetch(request)`.

### Artifacts `triggers.events`

- The trigger needs only a Workflow defined by the same Worker (`spec/research/artifacts.md`, "Events", route 2). In a Start app that is a class exported from `src/server.ts` and a `workflows` entry.
- The Vite plugin's list of ignored Wrangler fields (`tsconfig`, `rules`, `build`, `no_bundle`, `find_additional_modules`, `base_dir`, `preserve_file_names`; `spec/research/platform.md`) does not include `triggers`, and the output `wrangler.json` carries a `triggers` key _(observed locally, with an empty value — no trigger was configured)_.
- Not verified: a non-empty `triggers.events` block surviving the build, and delivery itself, which cannot run locally at all.

### Access, re-checked for this shape

Source: https://developers.cloudflare.com/workers/configuration/cloudflare-access/

> Workers with Static Assets execute behind an internal router Worker. Access still protects the application and its assets. However, the router does not pass `ctx.access` to the user Worker.
>
> The Cloudflare Vite plugin can add `assets` to the generated deployment configuration when the input Wrangler configuration omits it. Frameworks that use the plugin, including TanStack Start, can therefore be affected even when their source configuration does not declare Static Assets.

> Worker-level Access policies do not currently support WebSocket connections. WebSocket upgrade requests to a Worker protected by a worker-level Access policy will fail with a `403` error. If your Worker uses WebSockets (including Durable Objects, real-time applications, or RDP-over-WebSocket), protect it with a hostname-based Access application instead.

- Both findings in `spec/research/platform.md` and `spec/research/ai-identity.md` stand unchanged. The first is now stated by Cloudflare for TanStack Start by name, and the local build confirms the plugin adds `assets`.
- One difference from the SPA shape: there is no `run_worker_first` list to maintain. Start renders on the server, so every request that is not a built client asset reaches the Worker.

### shadcn/ui in a monorepo, app side

Sources: https://ui.shadcn.com/docs/monorepo · https://ui.shadcn.com/docs/installation/tanstack · https://ui.shadcn.com/docs/forms/tanstack-form

- "Every workspace must have a `components.json` file." The app's:

```json
{
  "$schema": "https://ui.shadcn.com/schema.json",
  "style": "base-nova",
  "rsc": true,
  "tsx": true,
  "tailwind": {
    "config": "",
    "css": "../../packages/ui/src/styles/globals.css",
    "baseColor": "neutral",
    "cssVariables": true
  },
  "iconLibrary": "lucide",
  "aliases": {
    "components": "@/components",
    "hooks": "@/hooks",
    "lib": "@/lib",
    "utils": "@workspace/ui/lib/utils",
    "ui": "@workspace/ui/components"
  }
}
```

- "Ensure you have the same `style`, `iconLibrary` and `baseColor` in both `components.json` files." "For Tailwind CSS v4, leave the `tailwind` config empty".
- Imports: `import { Button } from "@workspace/ui/components/button"`, `import { cn } from "@workspace/ui/lib/utils"`. The package exposes them through `exports` such as `"./components/*": "./src/components/*.tsx"`, `"./lib/*": "./src/lib/*.ts"`, `"./globals.css": "./src/styles/globals.css"`.
- Components are added from the app directory (`npx shadcn@latest add card`, or `-c apps/web` from the root); the CLI writes UI components into the package and blocks into the app.
- TanStack Form: shadcn documents it with its `Field` family, not a `Form` wrapper. The pattern, from the page:

```tsx
const form = useForm({
  defaultValues: { title: "", description: "" },
  validators: { onSubmit: formSchema },
  onSubmit: async ({ value }) => { /* … */ },
})

<form
  onSubmit={(e) => {
    e.preventDefault()
    form.handleSubmit()
  }}
>
  <FieldGroup>
    <form.Field
      name="title"
      children={(field) => {
        const isInvalid =
          field.state.meta.isTouched && !field.state.meta.isValid
        return (
          <Field data-invalid={isInvalid}>
            <FieldLabel htmlFor={field.name}>Bug Title</FieldLabel>
            <Input
              id={field.name}
              name={field.name}
              value={field.state.value}
              onBlur={field.handleBlur}
              onChange={(e) => field.handleChange(e.target.value)}
              aria-invalid={isInvalid}
            />
            {isInvalid && <FieldError errors={field.state.meta.errors} />}
          </Field>
        )
      }}
    />
  </FieldGroup>
  <Button type="submit">Submit</Button>
</form>
```

  (abridged: placeholder, `autoComplete` and the description are cut). The zod schema is passed straight to `validators`; no adapter package is imported. Components used: `Field`, `FieldLabel`, `FieldDescription`, `FieldError`, `FieldGroup` from `components/ui/field`.

## Local development and tests

- **`vite dev` runs the whole app in `workerd`** through the Cloudflare Vite plugin: SSR, server functions, server routes, D1, the Durable Object and its hibernatable WebSocket all worked with no account _(observed locally)_. State is under `.wrangler/state`. The Local Explorer is served at `/cdn-cgi/local/explorer`.
- **Wrangler writes outside the project.** `vite dev` registers the Worker in `~/Library/Preferences/.wrangler/registry` and fails with `EPERM` if it cannot _(observed locally, in a sandbox that denies it)_. Log files go to the same tree unless `WRANGLER_LOG_PATH` points elsewhere.
- **`wrangler types`, `vite build` and `tsc`** need neither network nor login.
- **Workers Vitest plugin with a test entry: works.** With `cloudflareTest({ main: "./src/server/test-entry.ts", wrangler: { configPath: "./wrangler.jsonc" } })`, where the test entry re-exports the Durable Object and Workflow classes and a trivial `fetch`, three tests passed under Vitest 4.1.11: a Durable Object RPC call through `env.CHANGE_ROOM.getByName(...)`, a D1 query, and a Workflow run observed with `introspectWorkflowInstance(env.CHANGE_PIPELINE, id)` / `waitForStepResult({ name })` _(observed locally)_.
- **Workers Vitest plugin with the real entry: fails.** `main: "./src/server.ts"` stops at `Missing "#tanstack-router-entry" specifier in "@tanstack/start-server-core" package` _(observed locally)_: Start's handler imports virtual entries that only its own Vite plugin provides. So routes, SSR, server functions and server routes cannot be exercised by that plugin.
- **What covers the rest:** TanStack's own examples test a Start app with Playwright against a running server (the Query guide runs `pnpm test:e2e`). `createTestHarness()` from `wrangler` runs built output (`spec/research/platform.md`); pointing it at `dist/server/wrangler.json` is the documented shape for a Vite-plugin project, and was not run here.
- **Needs Docker:** nothing in this note.
- **Cannot run locally:** Access (no JWT arrives), `triggers.events` delivery, and everything `spec/research/artifacts.md` and `ai-identity.md` list.

## Could not verify

- **Whether `Cf-Access-Jwt-Assertion` reaches a Start Worker.** Unchanged from `spec/research/platform.md`: the docs say only that `ctx.access` is not passed. Needs a deployed test behind a hostname-based Access application.
- **WebSocket upgrade through a server route in production.** Observed only under `vite dev`. Whether Start's response handling (header merging, streaming wrappers, early hints) leaves a `101` response intact on a deployed Worker was not tested; nor was the behaviour when request middleware wraps the route.
- **A populated `triggers.events` block through the Vite plugin build**, and whether `wrangler deploy` of the output config registers it. Only the empty key was seen.
- **Running a server function outside the Start build.** Not tried: whether an uncompiled `createServerFn(...)` can be imported and called in a plain Vitest (Node) test. Assume not.
- **`createTestHarness()` against a Start build**, and Playwright against `vite preview`. Documented separately; the combination was not run.
- **The `ExecutionContext` inside server functions.** No documented helper was found; forwarding it through `handler.fetch(request, { context })` is composed from two documented pieces and untested.
- **Agents SDK inside a Start app.** Not looked at; the design does not use it.
- **`@cloudflare/vitest-plugin` with Vitest 5.** Its peer range is `^4.1.0`; Vitest 4.1.11 was used.
- **shadcn's `components.json` `style` and `rsc` values for this repo.** The docs example shows `"base-nova"` and `"rsc": true`; the right values are whatever the UI package's own `components.json` uses, which this note did not decide.
- **TanStack Form `onSubmit` with zod 4.** The shadcn page says its example "uses `zod v3`" and that Form accepts any Standard Schema library; zod 4 was not exercised.
