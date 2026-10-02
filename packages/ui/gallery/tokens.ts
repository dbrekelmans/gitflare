import theme from "../src/styles/theme.css?raw";

export type Token = { name: string; value: string; note?: string };

// Read from the theme file itself, so the gallery cannot list a token the
// theme does not define, or miss one it does.
const declaration = /^\s*(--[a-z0-9-]+):\s*([^;]+);(?:\s*\/\*\s*(.*?)\s*\*\/)?/;

function parse(css: string): Token[] {
  const body = css.slice(css.indexOf("@theme {"), css.indexOf("\n}\n"));
  const tokens: Token[] = [];
  let pending = "";
  for (const line of body.split("\n")) {
    pending = pending ? `${pending} ${line.trim()}` : line;
    if (!pending.includes(";") && /^\s*--[a-z0-9-]+:/.test(pending)) continue;
    const match = declaration.exec(pending);
    pending = "";
    if (!match) continue;
    const [, name, value, note] = match;
    if (!name || !value || value === "initial") continue;
    tokens.push({ name, value: value.trim(), note });
  }
  return tokens;
}

export const tokens = parse(theme);

export function token(name: string): Token {
  const found = tokens.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`No token ${name} in theme.css`);
  return found;
}

export function namespace(prefix: string): Token[] {
  return tokens.filter(
    (candidate) =>
      candidate.name.startsWith(prefix) &&
      // --font-weight-* is its own namespace, not part of --font-*.
      !(prefix === "--font-" && candidate.name.startsWith("--font-weight-")),
  );
}

export const hex = (value: string) => value.toUpperCase();
