import type { AiBindingLike, GatewayLog } from "./gateway";

type Reply = { result: unknown; logId: string | null } | { error: Error };

/**
 * A stand-in for `env.AI` in this package's tests. Replies are queued and a
 * call nothing was queued for fails. Errors are thrown the way the binding
 * throws them: an `Error` whose message starts with the gateway's code.
 */
export class StubAi implements AiBindingLike {
  readonly calls: { model: string; inputs: Record<string, unknown>; options: unknown }[] = [];
  readonly logReads: string[] = [];
  /** The gateway's logs by id. A missing entry is "Log not found". */
  readonly logs = new Map<string, GatewayLog>();
  /** Called after each log read, to make a log appear late. */
  onLogRead: (logId: string, reads: number) => void = () => {};
  aiGatewayLogId: string | null = null;
  private readonly replies: Reply[] = [];

  /** Queues an Anthropic message with this text. */
  message(text: string, extra: { usage?: object; stop_reason?: string; logId?: string } = {}) {
    return this.returns(
      {
        id: "msg_1",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text }],
        model: "claude-sonnet-5",
        stop_reason: extra.stop_reason ?? "end_turn",
        usage: extra.usage ?? { input_tokens: 10, output_tokens: 5 },
        gatewayMetadata: { keySource: "Unified" },
      },
      extra.logId,
    );
  }

  /** Queues a server-sent event stream, delivered in the given chunks. */
  sse(chunks: string[], logId?: string) {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    });
    return this.returns(stream, logId);
  }

  returns(result: unknown, logId: string | null = null) {
    this.replies.push({ result, logId });
    return this;
  }

  throws(message: string) {
    const error = new Error(message);
    error.name = "AiGatewayError";
    this.replies.push({ error });
    return this;
  }

  async run(model: string, inputs: Record<string, unknown>, options?: unknown): Promise<unknown> {
    this.calls.push({ model, inputs, options });
    const reply = this.replies.shift();
    if (!reply) throw new Error(`StubAi: no reply queued for a call to ${model}`);
    if ("error" in reply) {
      this.aiGatewayLogId = null;
      throw reply.error;
    }
    this.aiGatewayLogId = reply.logId;
    return reply.result;
  }

  gateway(_id: string) {
    return {
      getLog: async (logId: string) => {
        this.logReads.push(logId);
        const log = this.logs.get(logId);
        this.onLogRead(logId, this.logReads.length);
        if (!log) throw new Error("Log not found");
        return log;
      },
    };
  }
}
