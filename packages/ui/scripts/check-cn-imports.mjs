#!/usr/bin/env node
// `shadcn add` writes `import { cn } from "cn"`; that `cn` has no theme config,
// so composite classes like `text-ui` and `text-ink` get merged as one
// property and one silently wins. Every component must import the
// theme-aware `cn` from `#lib/utils` instead.
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(fileURLToPath(import.meta.url), "..", "..")
const componentsDir = join(root, "src", "components")
const allowedSpecifier = "#lib/utils"
const importRe = /import\s+(?:type\s+)?(?:\{([^}]*)\}|(\w+))\s+from\s+["']([^"']+)["']/g

function walk(dir) {
  const files = []
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    const stats = statSync(path)
    if (stats.isDirectory()) files.push(...walk(path))
    else if (/\.(ts|tsx)$/.test(entry)) files.push(path)
  }
  return files
}

const violations = []

for (const file of walk(componentsDir)) {
  const source = readFileSync(file, "utf8")
  for (const match of source.matchAll(importRe)) {
    const [, named, defaultName, specifier] = match
    const bindings = named
      ? named.split(",").map((part) => part.trim().split(/\s+as\s+/).pop())
      : [defaultName]
    if (bindings.includes("cn") && specifier !== allowedSpecifier) {
      const line = source.slice(0, match.index).split("\n").length
      violations.push(`${relative(root, file)}:${line} imports \`cn\` from "${specifier}"`)
    }
  }
}

if (violations.length > 0) {
  console.error("Found `cn` imports that bypass the theme-aware helper at #lib/utils:\n")
  for (const violation of violations) console.error(`  ${violation}`)
  console.error(
    "\nAfter running `shadcn add`, change the generated `import { cn } from \"cn\"` to `import { cn } from \"#lib/utils\"`.",
  )
  process.exit(1)
}

console.log("All `cn` imports under src/components use #lib/utils.")
