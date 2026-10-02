import { AgentName, type MicroUsd, type ModelAttribution, type ModelUsage } from "@gitflare/core";
import {
  type EmbedResult,
  type GenerateRequest,
  type GenerateResult,
  ModelError,
  type ModelErrorCode,
  type ModelGateway,
  type ModelStreamEvent,
} from "@gitflare/core/ports";
import { z } from "zod";

/** The part of the `env.AI` binding this package calls. */
export interface AiBindingLike {
  run(
    model: string,
    inputs: Record<string, unknown>,
    options?: Record<string, unknown>,
  ): Promise<unknown>;
  readonly aiGatewayLogId: string | null;
  gateway(id: string): { getLog(logId: string): Promise<{ cost?: number }> };
}

/** US dollars per million tokens, which is also micro-dollars per token. */
export interface ModelPrice {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/**
 * The catalog's prices as read on 2026-10-02 (spec/research/ai-identity.md).
 * They are used only when the gateway's log has no cost for a call, so that a
 * call is never recorded as free; the log's own figure wins whenever it exists.
 */
export const catalogPrices: Record<string, ModelPrice> = {
  "anthropic/claude-fable-5.1": { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
  "anthropic/claude-opus-5.5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  "anthropic/claude-sonnet-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  "anthropic/claude-haiku-4.5": { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
};

export interface GatewayModelsOptions {
  gatewayId: string;
  /** Replaces `catalogPrices`. */
  prices?: Record<string, ModelPrice>;
  /** How long to wait before the second and last read of a call's log. */
  logRetryDelayMs?: number;
}

/** What a call that reached the model cost, whether or not its reply was usable. */
export type BilledCall = Pick<
  GenerateResult<unknown>,
  "model" | "usage" | "costMicroUsd" | "gatewayLogId"
>;

/**
 * A failure of a call the model did answer, and that was therefore paid for.
 * `withAccounting` records `call`, so replies that do not validate still count
 * towards a change's budget.
 */
export class BilledModelError extends ModelError {
  constructor(
    code: ModelErrorCode,
    message: string,
    readonly call: BilledCall,
  ) {
    super(code, message);
  }
}

const attributionKeys = ["agent", "userId", "repositoryId", "changeId", "sessionId"] as const;

/**
 * The attribution as gateway metadata: its five keys, absent ones left out.
 * Anything but a non-empty string throws, because the gateway answers one null
 * or object value by dropping every entry without an error.
 */
export function attributionMetadata(attribution: ModelAttribution): Record<string, string> {
  const metadata: Record<string, string> = {};
  for (const key of attributionKeys) {
    const value: unknown = attribution[key];
    if (value === undefined || value === null) continue;
    if (typeof value !== "string" || value === "") {
      throw new TypeError(`model attribution: ${key} must be a non-empty string`);
    }
    metadata[key] = value;
  }
  if (!AgentName.safeParse(metadata.agent).success) {
    throw new TypeError("model attribution: agent must be one of gitflare's agents");
  }
  return metadata;
}

const gatewayCodes: Record<string, ModelErrorCode> = {
  "2021": "no_credits",
  "2045": "budget_exceeded",
  "2003": "rate_limited",
};

/** The binding's thrown error has no status or code property: the code is the prefix of its message. */
function toModelError(error: unknown): ModelError {
  if (error instanceof ModelError) return error;
  const message = error instanceof Error ? error.message : String(error);
  const prefix = /^\s*(\d{4}):/.exec(message)?.[1];
  const modelError = new ModelError((prefix && gatewayCodes[prefix]) || "unavailable", message);
  modelError.cause = error;
  return modelError;
}

function outputInstruction(output: { name: string; schema: z.ZodType }): string {
  const schema = z.toJSONSchema(output.schema, { io: "input", unrepresentable: "any" });
  return [
    `Reply with one JSON value, "${output.name}", that matches the JSON Schema below.`,
    "Output only the JSON: no prose before or after it, and no code fence.",
    JSON.stringify(schema),
  ].join("\n");
}

function messagesBody(request: GenerateRequest<unknown>): Record<string, unknown> {
  // `system` has to be one string: the gateway rejects the array-of-blocks form.
  const system = [request.system, request.output && outputInstruction(request.output)]
    .filter(Boolean)
    .join("\n\n");
  return {
    max_tokens: request.maxOutputTokens,
    messages: request.messages.map(({ role, content }) => ({ role, content })),
    ...(system && { system }),
  };
}

const AnthropicUsage = z.object({
  input_tokens: z.number().nullish(),
  output_tokens: z.number().nullish(),
  cache_read_input_tokens: z.number().nullish(),
  cache_creation_input_tokens: z.number().nullish(),
});

const AnthropicMessage = z.object({
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
  stop_reason: z.string().nullish(),
  usage: AnthropicUsage.optional(),
});

const AnthropicStreamEvent = z.object({
  type: z.string(),
  message: z.object({ usage: AnthropicUsage.optional() }).optional(),
  delta: z
    .object({
      type: z.string().optional(),
      text: z.string().optional(),
      stop_reason: z.string().nullish(),
    })
    .optional(),
  usage: AnthropicUsage.optional(),
  error: z.object({ type: z.string().optional(), message: z.string().optional() }).optional(),
});

const Embeddings = z.object({ data: z.array(z.array(z.number())) });

interface Reply {
  text: string;
  usage: ModelUsage;
  stopReason: string | null;
}

function emptyUsage(): ModelUsage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
}

/** Sets the counts an event carries and leaves the others: a stream reports them in parts. */
function applyUsage(usage: ModelUsage, reported: z.infer<typeof AnthropicUsage> | undefined) {
  if (!reported) return;
  usage.inputTokens = reported.input_tokens ?? usage.inputTokens;
  usage.outputTokens = reported.output_tokens ?? usage.outputTokens;
  usage.cacheReadTokens = reported.cache_read_input_tokens ?? usage.cacheReadTokens;
  usage.cacheWriteTokens = reported.cache_creation_input_tokens ?? usage.cacheWriteTokens;
}

function readMessage(model: string, raw: unknown): Reply {
  const message = AnthropicMessage.safeParse(raw);
  if (!message.success) {
    throw new ModelError(
      "unavailable",
      `${model}: the gateway did not return an Anthropic message`,
    );
  }
  const usage = emptyUsage();
  applyUsage(usage, message.data.usage);
  const text = message.data.content
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("");
  return { text, usage, stopReason: message.data.stop_reason ?? null };
}

/** The reply as JSON: as it stands, or inside a code fence, or between its outermost brackets. */
function extractJson(text: string): { value: unknown } | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)?.[1];
  const start = text.search(/[{[]/);
  const end = Math.max(text.lastIndexOf("}"), text.lastIndexOf("]"));
  const bracketed = start >= 0 && end > start ? text.slice(start, end + 1) : undefined;
  for (const candidate of [text, fenced, bracketed]) {
    if (candidate === undefined) continue;
    try {
      return { value: JSON.parse(candidate) };
    } catch {
      // Not JSON read this way; try the next.
    }
  }
  return null;
}

function isReadableStream(value: unknown): value is ReadableStream<Uint8Array> {
  return typeof (value as { getReader?: unknown } | null)?.getReader === "function";
}

/** The JSON payload of each `data:` line of a server-sent event stream. */
async function* sseData(stream: ReadableStream<Uint8Array>): AsyncGenerator<unknown> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = done ? "" : (lines.pop() ?? "");
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        try {
          yield JSON.parse(line.slice(5));
        } catch {
          // A keep-alive or an end marker, not an event.
        }
      }
      if (done) return;
    }
  } finally {
    // Stops the upstream when the consumer leaves early; a no-op once it has ended.
    await reader.cancel().catch(() => undefined);
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The `ModelGateway` port over the AI binding and one named gateway. What the
 * live test established, and this adapter must do:
 *
 * - pass `skipCache: true` on every call: the gateway caches identical
 *   requests across users even with a zero cache lifetime;
 * - send `system` as a string, and never force a tool choice (Opus rejects
 *   it): ask for JSON in the prompt and validate the reply against the schema;
 * - validate metadata before sending: one null or object value makes the
 *   gateway drop all of it, and with it the request's budget partition;
 * - tell the errors apart by the code at the start of the thrown message:
 *   `402`/`2021` is `no_credits`, `429`/`2045` is `budget_exceeded`,
 *   `429`/`2003` is `rate_limited`.
 *
 * A call's cost is read from its gateway log, which can lag the response by
 * half a second: one retry, then an estimate from the token counts.
 */
export function createGatewayModels(
  ai: AiBindingLike,
  options: GatewayModelsOptions,
): ModelGateway {
  const { gatewayId, prices = catalogPrices, logRetryDelayMs = 500 } = options;

  const run = async (model: string, inputs: Record<string, unknown>, metadata: object) => {
    try {
      const raw = await ai.run(model, inputs, {
        gateway: { id: gatewayId, skipCache: true, metadata },
      });
      // The property holds the most recent call's id, so it is read before anything else is awaited.
      return { raw, logId: ai.aiGatewayLogId };
    } catch (error) {
      throw toModelError(error);
    }
  };

  const loggedCost = async (logId: string | null): Promise<MicroUsd | null> => {
    if (!logId) return null;
    for (const delay of [0, logRetryDelayMs]) {
      if (delay > 0) await sleep(delay);
      try {
        const { cost } = await ai.gateway(gatewayId).getLog(logId);
        if (typeof cost === "number") return Math.round(cost * 1_000_000);
      } catch {
        // "Log not found" until the gateway has written it.
      }
    }
    return null;
  };

  const estimatedCost = (model: string, usage: ModelUsage): MicroUsd => {
    const price = prices[model];
    if (!price) return 0;
    return Math.round(
      usage.inputTokens * price.input +
        usage.outputTokens * price.output +
        usage.cacheReadTokens * price.cacheRead +
        usage.cacheWriteTokens * price.cacheWrite,
    );
  };

  const finish = async <T>(
    request: GenerateRequest<T>,
    reply: Reply,
    logId: string | null,
  ): Promise<GenerateResult<T>> => {
    const call: BilledCall = {
      model: request.model,
      usage: reply.usage,
      costMicroUsd: (await loggedCost(logId)) ?? estimatedCost(request.model, reply.usage),
      gatewayLogId: logId,
    };
    if (!request.output) return { ...call, text: reply.text, output: undefined as T };

    const invalid = (reason: string) =>
      new BilledModelError(
        "invalid_output",
        `${request.model}: the reply is not a valid "${request.output?.name}": ${reason}`,
        call,
      );
    const json = extractJson(reply.text);
    if (!json) {
      throw invalid(
        reply.stopReason === "max_tokens" ? "it was cut off at max_tokens" : "it is not JSON",
      );
    }
    const parsed = request.output.schema.safeParse(json.value);
    if (!parsed.success) throw invalid(parsed.error.message);
    return { ...call, text: reply.text, output: parsed.data };
  };

  return {
    async generate<T = undefined>(request: GenerateRequest<T>): Promise<GenerateResult<T>> {
      const metadata = attributionMetadata(request.attribution);
      const { raw, logId } = await run(request.model, messagesBody(request), metadata);
      return finish(request, readMessage(request.model, raw), logId);
    },

    async *stream<T = undefined>(request: GenerateRequest<T>): AsyncIterable<ModelStreamEvent<T>> {
      const metadata = attributionMetadata(request.attribution);
      const body = { ...messagesBody(request), stream: true };
      const { raw, logId } = await run(request.model, body, metadata);

      if (!isReadableStream(raw)) {
        const reply = readMessage(request.model, raw);
        if (reply.text) yield { type: "text", text: reply.text };
        yield { type: "done", result: await finish(request, reply, logId) };
        return;
      }

      const reply: Reply = { text: "", usage: emptyUsage(), stopReason: null };
      let started = false;
      try {
        for await (const data of sseData(raw)) {
          const event = AnthropicStreamEvent.safeParse(data);
          if (!event.success) continue;
          const { type, message, delta, usage, error } = event.data;
          if (type === "message_start") {
            started = true;
            applyUsage(reply.usage, message?.usage);
          } else if (type === "content_block_delta" && delta?.type === "text_delta") {
            const text = delta.text ?? "";
            reply.text += text;
            if (text) yield { type: "text", text };
          } else if (type === "message_delta") {
            applyUsage(reply.usage, usage);
            reply.stopReason = delta?.stop_reason ?? reply.stopReason;
          } else if (type === "error") {
            throw new ModelError(
              error?.type === "rate_limit_error" ? "rate_limited" : "unavailable",
              `${request.model}: ${error?.message ?? error?.type ?? "the stream failed"}`,
            );
          }
        }
      } catch (error) {
        throw toModelError(error);
      }
      if (!started) {
        throw new ModelError("unavailable", `${request.model}: the stream carried no message`);
      }
      yield { type: "done", result: await finish(request, reply, logId) };
    },

    async embed(request): Promise<EmbedResult> {
      const metadata = attributionMetadata(request.attribution);
      // Token counts are not read yet: the hardening task takes them from the gateway log.
      const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
      if (request.texts.length === 0) {
        return { vectors: [], model: request.model, usage, costMicroUsd: 0, gatewayLogId: null };
      }
      const { raw, logId } = await run(request.model, { text: request.texts }, metadata);
      const embeddings = Embeddings.safeParse(raw);
      if (!embeddings.success || embeddings.data.data.length !== request.texts.length) {
        throw new ModelError(
          "unavailable",
          `${request.model}: the gateway did not return one vector per text`,
        );
      }
      return {
        vectors: embeddings.data.data,
        model: request.model,
        usage,
        costMicroUsd: (await loggedCost(logId)) ?? 0,
        gatewayLogId: logId ?? null,
      };
    },
  };
}
