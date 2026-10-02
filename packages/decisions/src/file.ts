import {
  type Decision,
  DecisionOrigin,
  DecisionStatus,
  ForgeError,
  isId,
  type Timestamp,
} from "@gitflare/core";
import { parse, stringify } from "yaml";
import { z } from "zod";

// The decision file. One markdown file per decision under `decisions/` on the
// context repo's `main`:
//
//   ---
//   id: dec_01k…
//   status: active
//   strength: 0.5
//   origin: dismissed_finding
//   origin_change: chg_01k…
//   origin_thread: thr_01k…
//   created: 2026-10-01T09:00:00.000Z
//   updated: 2026-10-01T09:00:00.000Z
//   ---
//
//   # The title
//
//   The statement.
//
//   ## Rationale
//
//   Why.
//
// The front matter holds what only gitflare writes; the body is what a person
// reads and may edit. Each field is in exactly one place, so a hand edit never
// has two versions to disagree. `paths:` is present only for a decision tied to
// path globs. History is not in the file: it is the file's git log, and the
// events in the index.

export const DECISIONS_DIR = "decisions";

const RATIONALE_HEADING = "## Rationale";
/** A line of the statement that would be read as the rationale heading, escaped or not. */
const HEADING_LOOKALIKE = /^\\*## Rationale\s*$/;
const ESCAPED_HEADING = /^\\+## Rationale\s*$/;

const isoTime = z.string().transform((value, ctx): Timestamp => {
  const time = Date.parse(value);
  if (Number.isNaN(time)) {
    ctx.addIssue({ code: "custom", message: "expected an ISO 8601 time" });
    return z.NEVER;
  }
  return time;
});

const idOf = <K extends Parameters<typeof isId>[0]>(kind: K) =>
  z.string().refine((value) => isId(kind, value), { message: `expected a ${kind} id` });

const FrontMatter = z.object({
  id: idOf("decision"),
  status: DecisionStatus,
  strength: z.number().min(0).max(1),
  paths: z.array(z.string()).optional(),
  origin: DecisionOrigin,
  origin_change: idOf("change").optional(),
  origin_thread: idOf("thread").optional(),
  created: isoTime,
  updated: isoTime,
});

/** A title is one line: it is the file's heading. */
export function cleanTitle(title: string): string {
  return title.replace(/\s+/g, " ").trim();
}

/** The decision's file: front matter the index can be rebuilt from, then the statement and rationale. */
export function renderDecisionFile(decision: Decision): string {
  const frontMatter = stringify({
    id: decision.id,
    status: decision.status,
    strength: decision.strength,
    ...(decision.scope.kind === "paths" && { paths: decision.scope.globs }),
    origin: decision.origin,
    ...(decision.originChangeId && { origin_change: decision.originChangeId }),
    ...(decision.originThreadId && { origin_thread: decision.originThreadId }),
    created: new Date(decision.createdAt).toISOString(),
    updated: new Date(decision.updatedAt).toISOString(),
  });
  const statement = decision.statement
    .trim()
    .split("\n")
    .map((line) => (HEADING_LOOKALIKE.test(line) ? `\\${line}` : line))
    .join("\n");
  const rationale = decision.rationale.trim();
  const body = [`# ${cleanTitle(decision.title)}`, statement];
  if (rationale) body.push(RATIONALE_HEADING, rationale);
  return `---\n${frontMatter}---\n\n${body.join("\n\n")}\n`;
}

/** Reads a decision's file back. Throws a `ForgeError` naming the path when it is not one. */
export function parseDecisionFile(path: string, text: string): Omit<Decision, "repositoryId"> {
  const fail = (why: string) => new ForgeError("invalid", `${path}: ${why}`);
  const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?([\s\S]*)$/.exec(text);
  if (!match) throw fail("no front matter");

  let raw: unknown;
  try {
    raw = parse(match[1] ?? "");
  } catch (error) {
    throw fail(`front matter is not YAML: ${error instanceof Error ? error.message : error}`);
  }
  const parsed = FrontMatter.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw fail(`front matter ${issue?.path.join(".") ?? ""}: ${issue?.message ?? "invalid"}`);
  }
  const front = parsed.data;

  const lines = (match[2] ?? "").replace(/\r\n/g, "\n").trim().split("\n");
  const heading = lines.shift() ?? "";
  if (!heading.startsWith("# ")) throw fail("the body must start with the title as a heading");
  const title = cleanTitle(heading.slice(2));
  if (!title) throw fail("the title is empty");

  const split = lines.indexOf(RATIONALE_HEADING);
  const statement = (split === -1 ? lines : lines.slice(0, split))
    .map((line) => (ESCAPED_HEADING.test(line) ? line.slice(1) : line))
    .join("\n")
    .trim();
  if (!statement) throw fail("the statement is empty");
  const rationale =
    split === -1
      ? ""
      : lines
          .slice(split + 1)
          .join("\n")
          .trim();

  return {
    id: front.id as Decision["id"],
    path,
    title,
    statement,
    rationale,
    scope: front.paths ? { kind: "paths", globs: front.paths } : { kind: "general" },
    status: front.status,
    strength: front.strength,
    origin: front.origin,
    originChangeId: (front.origin_change ?? null) as Decision["originChangeId"],
    originThreadId: (front.origin_thread ?? null) as Decision["originThreadId"],
    createdAt: front.created,
    updatedAt: front.updated,
  };
}

/** `decisions/<the title as a slug>.md`, or null when the title has nothing a path can hold. */
export function decisionPath(title: string, attempt: number): string | null {
  const slug = title
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/, "");
  if (!slug) return null;
  return `${DECISIONS_DIR}/${slug}${attempt > 1 ? `-${attempt}` : ""}.md`;
}
