# Building gitflare

Read `spec/architecture.md` first: it has the package map, the contracts and your build task. This file is the commands and the conventions.

## Commands

Run from the repository root. Node 22.13 or later, pnpm 11.

| Command | What it does |
| --- | --- |
| `pnpm install` | Install. Needs the npm registry: pnpm checks package ages on every install. |
| `pnpm dev` | The forge at http://localhost:3000, on fakes and the demo data. No Cloudflare account, no Docker. |
| `pnpm typecheck` | `tsc` in every package. For the forge it first regenerates `worker-configuration.d.ts`. |
| `pnpm lint` / `pnpm lint:fix` | Biome: lint and format. |
| `pnpm test` | Every test: Node, React (happy-dom) and Workers runtime. |
| `pnpm vitest run packages/<name>` | One package's tests. `pnpm --filter @gitflare/<name> test` does the same. |
| `pnpm check` | Typecheck, lint, test. What CI runs; run it before you push. |

`pnpm dev` wipes nothing. Local state is in `apps/forge/.wrangler/state`; delete that directory to reseed the demo.

## Where code goes

- **A domain package (`packages/<name>`) is plain TypeScript.** It never imports `cloudflare:workers`, and never another domain package: where it needs one, it takes the port (`capture`, `diffs`, `decisions`). It takes what it needs as an argument: `{ db, git, models, clock, … }`, typed as a `Pick` of the ports in `@gitflare/core/ports` plus `Db` from `@gitflare/db`. That is what makes it testable in Node.
- **Durable Object and Workflow classes are thin shells** in `apps/forge/src/server/durable` and `…/workflows`. A shell reads `env`, builds the dependencies with `getServices()`, and calls package functions. No logic, no SQL.
- **`apps/forge/src/server/services.ts` is the only composition root.** Nothing else reads `env` except the shells and server routes that need a binding directly.
- **Contracts are in `@gitflare/core`**: domain types, state machines, ports, and the API (`@gitflare/core/api`). Do not redefine a type that is there. If a contract is wrong, say so in your task comment; do not work around it.
- **Stubs throw `NotImplementedError`** (`notImplemented("what")`). Replace the ones your task owns; leave the rest.

## Tests

- Test a domain package in Node with `createTestDb()` (`@gitflare/db/testing`, a real SQLite with the migrations applied) and `createFakePorts()` (`@gitflare/testing`). Do not write your own fake of a port; if a fake lacks something, say so in your task comment.
- `seedDemo(db)` loads the demo fixture; `demo` from `@gitflare/testing/demo` is the same data as objects.
- A file named `*.test.ts` runs in Node, `*.test.tsx` in happy-dom, `*.worker.test.ts` in workerd with local D1, Durable Objects and Workflows.
- Worker tests load `apps/forge/src/server/test-entry.ts`, not the app. Routes, server functions and SSR cannot be loaded by Vitest; keep server functions one line long and test what they call.
- The fake model gateway fails a call nobody scripted. Script replies with `models.reply(agent, { output })`.

## The web app

It is TanStack Start. Three layers, and screens only touch the last:

1. `src/server/api/<slice>.ts` implements a slice of `ForgeApi`.
2. `src/data/<slice>.functions.ts` wraps each operation in a server function: `authed` middleware, the operation's input schema as `.validator(...)`, a one-line handler. Use `.validator`, not the deprecated `.inputValidator`.
3. `src/data/<slice>.queries.ts` exports `queryOptions` factories and mutation hooks.

Rules for screens:

- **Read with a query, in the loader and the component both.** The route's `loader` calls `context.queryClient.ensureQueryData(xQueries.y(...))`; the component calls `useSuspenseQuery` with the same options. Never `useEffect` + fetch, never a server function called from a component.
- **Write with a mutation hook from `src/data`** (`useApproveSection()`, …). They are built with `useApiMutation`, which invalidates what the write made stale and stays pending until it has refetched. Do not invalidate by hand in a component.
- **Query keys come from `src/data/keys.ts`.** Do not write a key inline.
- **Live updates are not your concern.** `useChangeLive(changeId)` invalidates the change's queries when something happens; your component reads queries.
- **Forms are TanStack Form**, written like `src/routes/repos/new.tsx`: the operation's input schema from `@gitflare/core/api` validates on submit, fields render with the `Field` family from the UI package, and `onSubmit` awaits a mutation hook.
- **Route files stay thin**: loader, params, the page component. Put components beside the route in a folder whose name starts with `-` (`routes/changes/-components/…`); the router ignores those.
- **Do not add, rename or delete a route file** without saying so in your pull request: it rewrites `routeTree.gen.ts`, which every screen task shares. After merging `main`, run `pnpm build` to regenerate it rather than resolving the conflict by hand.
- **Look at what you built**: `pnpm dev`, then the `agent-browser` skill against `http://localhost:3000` only. Always pass a named session (`agent-browser --session <your-task> …`) and close only that one. Never run `agent-browser close --all`: sessions are shared by every agent on the machine, and it closes theirs.
- Links inside the app are `RouteLink` (`src/components/shell/link.tsx`) or TanStack's `Link`. Timestamps and money go through `src/lib/format.ts` so the server and the browser print the same text.

In local development an API operation that is not built yet is answered from the fixture, so your screen works before its backend exists. What a fixture operation writes is kept in memory only.

## UI

Everything visual comes from `@gitflare/ui`. There is no barrel: import by path.

```ts
import { Button } from "@gitflare/ui/components/ui/button"; // shadcn components
import { Row } from "@gitflare/ui/components/row"; // gitflare's own
import { cn } from "@gitflare/ui/lib/utils";
```

- **To add a shadcn component**, run `pnpm exec shadcn add <name>` in `apps/forge`. It writes `packages/ui/src/components/ui/<name>.tsx`. Then, in that new file, change `import { cn } from "cn"` to `import { cn } from "#lib/utils"`: the stock `cn` does not know gitflare's theme and silently drops classes. Adding a file there is allowed; editing an existing one is not yours to do.
- **`--primary` is flare.** A stock component renders its checked and selected states in flare until its source is edited. Flare is the one accent: if a new component puts it somewhere that is not the single most important thing on the screen, change the component to ink.
- **Buttons**: `default` is ink, the standing action; `variant="flare"` is for the one moment per view; `outline` is the secondary.
- **Spacing and type are Tailwind's stock scales** (`p-4` is 16px). Paper's own steps are `p-s1` … `p-s18` and the type utilities are `type-body`, `type-title`, …. Radii are shadcn's: `rounded-lg` is 12px. The stock colour palette and shadow scale do not exist: `bg-black/50` and `shadow-md` render nothing.
- **Mono means a machine wrote or verified it.** Use `Evidence` for ids, hashes, counts and measurements. Never for a label, a heading or decoration.
- The design rules in `.bb/AGENTS.md` apply to every screen: claim on the left, evidence on the right; hairlines, not boxes; one elevated surface per view.
- The app is wrapped in `TooltipProvider`. Base UI's `Select` shows the raw value unless given `items`.

## Changing something you do not own

Your task owns the paths listed for it in `spec/architecture.md`. Everything else is someone else's.

- **Dependencies**: add one to your own `package.json`. `apps/forge/package.json` is shared by every task that works in the forge: add one line, in alphabetical order, and say so in the pull request. The lockfile is the one root file everyone changes; on conflict, merge `main` and run `pnpm install`, which resolves it. pnpm refuses packages published in the last day; pick an older version rather than editing `pnpm-workspace.yaml`.
- **The database schema** (`packages/db`) is shared and migrations are ordered. If you need a column, say so in your task comment before writing code against it. Do not generate a migration in a feature branch.
- **`@gitflare/core`, `@gitflare/testing`, root config, `src/server/services.ts`, `src/server.ts`, the Wrangler configs**: the smallest possible edit, called out in the pull request.

## Cloudflare APIs

Most of what this is built on is newer than your training data. Before writing code against Artifacts, Containers, Workflows, AI Gateway, Access or TanStack Start, read the matching note in `spec/research/` and check the live docs. Where a note in `spec/research/live/` covers the same thing, it wins: it records what a real account did. Copy signatures from there. In an adapter package, declare the part of a binding you call as your own interface (see `ArtifactsBindingLike`) rather than depending on generated Worker types.

Nothing in this repository deploys, and nothing in a test or in `pnpm dev` reaches a Cloudflare account.
