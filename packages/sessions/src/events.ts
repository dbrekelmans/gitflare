import type { CloudSessionEvent, SessionId } from "@gitflare/core";
import { z } from "zod";

/** A session event before it has a place in the session's log. */
export type SessionEventDraft = CloudSessionEvent extends infer E
  ? E extends CloudSessionEvent
    ? Omit<E, "sessionId" | "seq">
    : never
  : never;

const at = z.number().int().nonnegative();

/** One line of a turn's stream, as the turn script writes it (`TURN_SCRIPT`). */
const StreamLine = z.union([
  z.object({ at, agent: z.string() }),
  z.object({ at, pushed: z.string().regex(/^[0-9a-f]{40}$/) }),
  z.object({ at, error: z.string().min(1) }),
]);

// Claude Code's `stream-json` events, as far as a session shows them. Without
// `--include-partial-messages` an `assistant` event is one whole message, not
// an increment of one.
const AssistantEvent = z.object({
  type: z.literal("assistant"),
  message: z.object({ content: z.array(z.unknown()) }),
});
const TextBlock = z.object({ type: z.literal("text"), text: z.string() });
const ToolUseBlock = z.object({
  type: z.literal("tool_use"),
  name: z.string().min(1),
  input: z.unknown(),
});
const ResultEvent = z.object({
  type: z.literal("result"),
  is_error: z.boolean().optional(),
  result: z.string().optional(),
});

/** The inputs that say what a tool call was about, most telling first. */
const SUMMARY_KEYS = [
  "file_path",
  "pattern",
  "command",
  "url",
  "query",
  "path",
  "description",
  "prompt",
];
const SUMMARY_LENGTH = 200;

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function toolSummary(input: unknown): string {
  if (typeof input !== "object" || input === null) return "";
  const values = input as Record<string, unknown>;
  for (const key of SUMMARY_KEYS) {
    const value = values[key];
    if (typeof value !== "string" || value.trim() === "") continue;
    const line = value.trim().split("\n", 1)[0] ?? "";
    return line.length > SUMMARY_LENGTH ? `${line.slice(0, SUMMARY_LENGTH - 1)}…` : line;
  }
  return "";
}

function agentEvents(line: string, time: number): SessionEventDraft[] {
  const event = parseJson(line);
  const assistant = AssistantEvent.safeParse(event);
  if (assistant.success) {
    return assistant.data.message.content.flatMap((block): SessionEventDraft[] => {
      const text = TextBlock.safeParse(block);
      if (text.success) {
        const said = text.data.text.trim();
        return said === "" ? [] : [{ at: time, type: "assistant", text: said }];
      }
      const tool = ToolUseBlock.safeParse(block);
      if (tool.success) {
        const { name, input } = tool.data;
        return [{ at: time, type: "tool", name, summary: toolSummary(input) }];
      }
      return [];
    });
  }
  // The exit code does not say whether a model request failed; `is_error` does.
  // A successful result repeats the last thing the agent said.
  const result = ResultEvent.safeParse(event);
  if (result.success && result.data.is_error) {
    const message = result.data.result?.trim() || "The agent reported an error.";
    return [{ at: time, type: "error", message }];
  }
  return [];
}

/** What one turn's stream says happened, in order. A line that is not understood contributes nothing. */
export function readTurnStream(jsonl: string): SessionEventDraft[] {
  return jsonl.split("\n").flatMap((text): SessionEventDraft[] => {
    const line = StreamLine.safeParse(parseJson(text));
    if (!line.success) return [];
    const entry = line.data;
    if ("agent" in entry) return agentEvents(entry.agent, entry.at);
    if ("pushed" in entry) return [{ at: entry.at, type: "pushed", sha: entry.pushed }];
    return [{ at: entry.at, type: "error", message: entry.error }];
  });
}

/** Numbers drafts from 1 in the order given and keeps those after `after`. */
export function numberEvents(
  sessionId: SessionId,
  drafts: SessionEventDraft[],
  after: number,
): CloudSessionEvent[] {
  return drafts
    .map((draft, index) => ({ ...draft, sessionId, seq: index + 1 }) as CloudSessionEvent)
    .filter((event) => event.seq > after);
}

/**
 * Turns the agent's event stream for one turn (one JSON object per line, as
 * `TURN_SCRIPT` stamps it) into session events, numbered from 1. Lines it does
 * not understand are skipped: the stream is written by code running in the
 * sandbox and is not trusted.
 */
export function parseAgentEvents(
  sessionId: SessionId,
  jsonl: string,
  after: number,
): CloudSessionEvent[] {
  return numberEvents(sessionId, readTurnStream(jsonl), after);
}
