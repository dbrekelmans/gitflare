import { describe, expect, it } from "vitest";
import { parseAgentEvents } from "./events";

const sessionId = "ses_test";
const sha = "3f1c9a7e5b2d4f6081a2b3c4d5e6f708192a3b4c";

/** A line of the agent's own output, stamped as the turn script stamps it. */
function agent(at: number, event: unknown): string {
  return JSON.stringify({ at, agent: typeof event === "string" ? event : JSON.stringify(event) });
}

function assistant(...content: unknown[]) {
  return { type: "assistant", message: { role: "assistant", content } };
}

describe("parseAgentEvents", () => {
  it("turns the agent's messages into events, in the order they were printed", () => {
    const stream = [
      agent(10, { type: "system", subtype: "init", session_id: "abc" }),
      agent(
        20,
        assistant(
          { type: "text", text: "Looking for the audit log.\n" },
          {
            type: "tool_use",
            id: "t1",
            name: "Grep",
            input: { pattern: "audit_log", path: "src" },
          },
        ),
      ),
      agent(
        30,
        assistant({
          type: "tool_use",
          id: "t2",
          name: "Write",
          input: { file_path: "src/audit/export.ts", content: "export {};\n" },
        }),
      ),
      agent(40, assistant({ type: "text", text: "Added the export." })),
      agent(50, {
        type: "result",
        subtype: "success",
        is_error: false,
        result: "Added the export.",
      }),
      JSON.stringify({ at: 60, pushed: sha }),
    ].join("\n");

    expect(parseAgentEvents(sessionId, stream, 0)).toEqual([
      { sessionId, seq: 1, at: 20, type: "assistant", text: "Looking for the audit log." },
      { sessionId, seq: 2, at: 20, type: "tool", name: "Grep", summary: "audit_log" },
      { sessionId, seq: 3, at: 30, type: "tool", name: "Write", summary: "src/audit/export.ts" },
      { sessionId, seq: 4, at: 40, type: "assistant", text: "Added the export." },
      { sessionId, seq: 5, at: 60, type: "pushed", sha },
    ]);
  });

  it("skips lines it does not understand", () => {
    const stream = [
      "",
      "not json at all",
      '{"at": 1, "agent": ',
      "[1, 2, 3]",
      "null",
      JSON.stringify({ agent: JSON.stringify(assistant({ type: "text", text: "no time" })) }),
      JSON.stringify({ at: "soon", agent: "{}" }),
      agent(5, "the agent printed a warning, not JSON"),
      agent(6, { type: "assistant", message: "not a message" }),
      agent(7, assistant({ type: "thinking", thinking: "…" }, { type: "tool_use", input: {} })),
      agent(8, assistant({ type: "text", text: "   " })),
      JSON.stringify({ at: 9, pushed: "not-a-commit" }),
      JSON.stringify({ at: 10, prompt: "a prompt the user never wrote" }),
      agent(11, assistant({ type: "text", text: "Still here." })),
    ].join("\n");

    expect(parseAgentEvents(sessionId, stream, 0)).toEqual([
      { sessionId, seq: 1, at: 11, type: "assistant", text: "Still here." },
    ]);
  });

  it("reports a failed run from the result event, whatever the exit code was", () => {
    const stream = [
      agent(1, {
        type: "result",
        subtype: "success",
        is_error: true,
        api_error_status: 402,
        result: "API Error: 402 Insufficient wholesale credits.",
      }),
      JSON.stringify({ at: 2, error: "The agent's commits could not be pushed to the fork." }),
    ].join("\n");

    expect(parseAgentEvents(sessionId, stream, 0)).toEqual([
      {
        sessionId,
        seq: 1,
        at: 1,
        type: "error",
        message: "API Error: 402 Insufficient wholesale credits.",
      },
      {
        sessionId,
        seq: 2,
        at: 2,
        type: "error",
        message: "The agent's commits could not be pushed to the fork.",
      },
    ]);
  });

  it("summarises a tool call in one short line", () => {
    const summary = (name: string, input: unknown) => {
      const [event] = parseAgentEvents(
        sessionId,
        agent(1, assistant({ type: "tool_use", name, input })),
        0,
      );
      return event?.type === "tool" ? event.summary : undefined;
    };
    expect(summary("Bash", { command: "pnpm test\npnpm lint", description: "Run checks" })).toBe(
      "pnpm test",
    );
    expect(summary("Bash", { command: "x".repeat(500) })).toHaveLength(200);
    expect(summary("TodoWrite", { todos: [] })).toBe("");
    expect(summary("Odd", "not an object")).toBe("");
  });

  it("returns only the events after the one the caller has", () => {
    const stream = [1, 2, 3]
      .map((n) => agent(n, assistant({ type: "text", text: `message ${n}` })))
      .join("\n");
    expect(parseAgentEvents(sessionId, stream, 2).map((event) => event.seq)).toEqual([3]);
    expect(parseAgentEvents(sessionId, stream, 3)).toEqual([]);
  });
});
