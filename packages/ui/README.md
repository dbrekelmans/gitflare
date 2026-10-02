# @gitflare/ui

shadcn/ui on Base UI, themed to Gitflare's design tokens, with Gitflare's own components on top.

## After running `shadcn add`

`shadcn add` generates components that import `cn` from the `cn` package:

```ts
import { cn } from "cn"
```

That `cn` has no theme config, so composite classes like `text-ui` (a size) and `text-ink`
(a colour) get merged as if they were one property and one silently wins. Change the import
to the package's own theme-aware helper before committing:

```ts
import { cn } from "#lib/utils"
```

Run `pnpm check:cn-imports` (or `pnpm --filter @gitflare/ui check:cn-imports` from the repo
root) to confirm nothing under `src/components` imports `cn` from anywhere else.

## Scripts

- `pnpm dev` — run the component gallery
- `pnpm build` — build the gallery
- `pnpm typecheck` — `tsc --noEmit`
- `pnpm check:cn-imports` — fail if any file under `src/components` imports `cn` from anywhere
  but `#lib/utils`
