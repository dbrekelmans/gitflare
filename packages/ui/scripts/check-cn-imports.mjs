#!/usr/bin/env node
// `shadcn add` writes `import { cn } from "cn"`; that `cn` has no theme config,
// so composite classes like `text-ui` and `text-ink` get merged as if they
// were one property and one silently wins. Every component must import the
// theme-aware `cn` from `#lib/utils` instead.
//
// Two rules, either of which fails the check:
//
//   A. The specifier is the `cn` package itself (or a subpath), whatever
//      sits between the keyword and `from` — default, namespace, named,
//      aliased, combined, or a re-export.
//   B. A *named local binding* called `cn` is imported or re-exported from
//      any specifier that isn't the package's own helper (`#lib/utils`, or
//      a relative path that resolves to the same file) — this catches a
//      `cn` smuggled in from some other package, not just the literal `cn`
//      package.
import { readdirSync, readFileSync, statSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(fileURLToPath(import.meta.url), "..", "..")
const componentsDir = join(root, "src", "components")
const utilsPath = resolve(root, "src/lib/utils.ts")

const importFromRe = /\b(import|export)\b([\s\S]*?)\bfrom\s*["']([^"']+)["']/g

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

// Matches the "cn" package itself and any of its subpaths (e.g. "cn/config"),
// not files or aliases that merely contain "cn", like "#lib/utils".
function isCnPackageSpecifier(specifier) {
  return specifier === "cn" || specifier.startsWith("cn/")
}

// True if `specifier`, resolved from `file`, is the package's own cn helper.
function resolvesToUtils(file, specifier) {
  if (specifier === "#lib/utils") return true
  if (!specifier.startsWith(".")) return false
  const base = resolve(dirname(file), specifier)
  return [base, `${base}.ts`, `${base}.tsx`].includes(utilsPath)
}

// Local bindings a single import/export clause (the text between the
// keyword and `from`) brings into scope: default, namespace, and named
// (aliased or not).
function localBindings(clause) {
  const bindings = []

  const namespaceMatch = clause.match(/\*\s+as\s+(\w+)/)
  if (namespaceMatch) bindings.push(namespaceMatch[1])

  const namedMatch = clause.match(/\{([^}]*)\}/)
  if (namedMatch) {
    for (const rawPart of namedMatch[1].split(",")) {
      const part = rawPart.trim().replace(/^type\s+/, "")
      if (!part) continue
      const asMatch = part.match(/\bas\s+(\w+)$/)
      bindings.push(asMatch ? asMatch[1] : part)
    }
  }

  const beforeBrace = clause.split(/[{*]/)[0].trim().replace(/^type\s+/, "")
  const defaultMatch = beforeBrace.match(/^(\w+)\s*,?$/)
  if (defaultMatch) bindings.push(defaultMatch[1])

  return bindings
}

function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, "")
}

const violations = []

for (const file of walk(componentsDir)) {
  const source = stripComments(readFileSync(file, "utf8"))
  for (const match of source.matchAll(importFromRe)) {
    const [, , clause, specifier] = match
    if (resolvesToUtils(file, specifier)) continue

    const reason = isCnPackageSpecifier(specifier)
      ? `imports from "${specifier}"`
      : localBindings(clause).includes("cn")
        ? `imports a binding named \`cn\` from "${specifier}"`
        : null
    if (!reason) continue

    const line = source.slice(0, match.index).split("\n").length
    violations.push(`${relative(root, file)}:${line} ${reason} instead of #lib/utils`)
  }
}

if (violations.length > 0) {
  console.error("Found imports that bypass the theme-aware `cn` helper at #lib/utils:\n")
  for (const violation of violations) console.error(`  ${violation}`)
  console.error(
    "\nAfter running `shadcn add`, change the generated `import { cn } from \"cn\"` to `import { cn } from \"#lib/utils\"`.",
  )
  process.exit(1)
}

console.log("No file under src/components imports `cn` from anywhere but #lib/utils.")
