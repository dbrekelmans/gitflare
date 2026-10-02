import type { TranscriptTurn } from "@gitflare/core";

// Parsing for the two transcript shapes Entire stores. `transcript.jsonl` is
// its own compact, cross-agent format (preferred); `full.jsonl` is whatever
// the agent vendor writes natively — only Claude Code's shape is handled
// here, which is what the demo and the MVP's one supported agent use.
// `thinking` blocks are dropped: `TranscriptTurn` has no `thinking` kind, and
// Entire's own compact format already strips them.

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

function tsToTimestamp(ts: unknown): number | null {
  if (typeof ts !== "string") return null;
  const ms = Date.parse(ts);
  return Number.isNaN(ms) ? null : ms;
}

function toolTarget(name: string, input: Record<string, unknown>): string {
  if (EDIT_TOOLS.has(name) && typeof input.file_path === "string") return input.file_path;
  if (typeof input.file_path === "string") return input.file_path;
  if (typeof input.command === "string") return input.command;
  if (typeof input.pattern === "string") return input.pattern;
  if (typeof input.prompt === "string") return input.prompt;
  return "";
}

/** Splits transcript text into raw lines, dropping the empty line a trailing newline leaves. */
export function splitLines(text: string): string[] {
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

interface CompactContentBlock {
  type?: string;
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
}

interface CompactLine {
  agent?: string;
  type?: string;
  ts?: unknown;
  content?: unknown;
}

function textOfCompactUserContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  // The docs show a plain string; observed data is an array of `{id?, text}`
  // blocks. Accept both.
  return content
    .map((block) =>
      typeof block === "string" ? block : typeof block?.text === "string" ? block.text : "",
    )
    .filter((text) => text.length > 0)
    .join("\n");
}

/** Entire's compact `transcript.jsonl` lines, already sliced to one checkpoint's part. */
export function parseCompactLines(lines: string[]): {
  turns: TranscriptTurn[];
  agent: string | null;
} {
  const turns: TranscriptTurn[] = [];
  let agent: string | null = null;
  for (const line of lines) {
    if (!line.trim()) continue;
    let entry: CompactLine;
    try {
      entry = JSON.parse(line);
    } catch {
      // Transcripts are appended live; a torn final line is normal.
      continue;
    }
    if (!agent && typeof entry.agent === "string") agent = entry.agent;
    const at = tsToTimestamp(entry.ts);
    if (entry.type === "user") {
      const text = textOfCompactUserContent(entry.content);
      if (text) turns.push({ kind: "prompt", text, at });
      continue;
    }
    if (entry.type === "assistant" && Array.isArray(entry.content)) {
      for (const block of entry.content as CompactContentBlock[]) {
        if (block.type === "text" && block.text?.trim()) {
          turns.push({ kind: "assistant", text: block.text, at });
        } else if (block.type === "tool_use") {
          const name = block.name ?? "?";
          const target = toolTarget(name, block.input ?? {});
          turns.push({ kind: "tool", text: `${name}: ${target}`, at });
        }
      }
    }
  }
  return { turns, agent };
}

interface FullEntry {
  type?: string;
  timestamp?: unknown;
  message?: { role?: string; content?: unknown };
}

function textOfFullContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}

/** An agent's own native JSONL (Claude Code's shape), already sliced to one checkpoint's part. */
export function parseFullLines(lines: string[]): TranscriptTurn[] {
  const turns: TranscriptTurn[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    let entry: FullEntry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const at = tsToTimestamp(entry.timestamp);
    if (entry.type === "user" && entry.message?.role === "user") {
      // Tool results arrive as user-role entries with no text block; skip those.
      const text = textOfFullContent(entry.message.content).trim();
      if (text) turns.push({ kind: "prompt", text, at });
      continue;
    }
    if (entry.type === "assistant" && Array.isArray(entry.message?.content)) {
      for (const block of entry.message.content as Record<string, unknown>[]) {
        if (block?.type === "text" && typeof block.text === "string" && block.text.trim()) {
          turns.push({ kind: "assistant", text: block.text, at });
        } else if (block?.type === "tool_use") {
          const name = String(block.name ?? "?");
          const target = toolTarget(name, (block.input as Record<string, unknown>) ?? {});
          turns.push({ kind: "tool", text: `${name}: ${target}`, at });
        }
      }
    }
  }
  return turns;
}
