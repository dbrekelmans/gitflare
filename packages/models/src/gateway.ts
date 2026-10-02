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
  gateway(id: string): { getLog(logId: string): Promise<GatewayLog> };
}

/** The fields of an `AiGatewayLog` this package reads. */
export interface GatewayLog {
  cost?: number;
  tokens_in?: number;
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
 * Only a fallback: the gateway log's cost wins whenever it exists, and every
 * use of these, or of no price at all, logs a warning, because prices change.
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
 * `withAccounting` records `call`, so replies that do not validate, and streams
 * cut off part-way, still count towards a change's budget.
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

type BillingSink = (call: BilledCall) => Promise<void>;

const billingSink = Symbol("billingSink");

/**
 * A copy of the request carrying `sink`, which is told of every call made for
 * it that was paid for but reaches the caller neither as a result nor as a
 * `BilledModelError`: a stream the consumer left, a failure a fallback
 * answered. The sink survives `{ ...request }`, so wrappers pass it on.
 */
export function withBillingSink<R extends object>(request: R, sink: BillingSink): R {
  return { ...request, [billingSink]: sink };
}

/** Reports `call` to the request's billing sink, when it has one. */
export async function reportBilled(request: object, call: BilledCall): Promise<void> {
  await (request as { [billingSink]?: BillingSink })[billingSink]?.(call);
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
  "7003": "invalid_request",
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

/** The reply, or null when the gateway answered with something that is not an Anthropic message. */
function readMessage(raw: unknown): Reply | null {
  const message = AnthropicMessage.safeParse(raw);
  if (!message.success) return null;
  const usage = emptyUsage();
  applyUsage(usage, message.data.usage);
  const text = message.data.content
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("");
  return { text, usage, stopReason: message.data.stop_reason ?? null };
}

/** The index of the bracket that closes the one at `start`, skipping strings; -1 when none does. */
function closingBracket(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const char = text[i];
    if (inString) {
      if (char === "\\") i++;
      else if (char === '"') inString = false;
    } else if (char === '"') {
      inString = true;
    } else if (char === "{" || char === "[") {
      depth++;
    } else if (char === "}" || char === "]") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Every JSON value the reply could be meant as, in order: the reply as it
 * stands, inside a code fence, then each balanced bracketed span. Prose may
 * hold brackets of its own (`See [1]. {…}`), so the caller takes the first
 * that matches its schema rather than the first that parses.
 */
function* jsonCandidates(text: string): Generator<unknown> {
  const parse = (candidate: string) => {
    try {
      return { value: JSON.parse(candidate) as unknown };
    } catch {
      return null;
    }
  };
  const whole = parse(text);
  if (whole) yield whole.value;
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)?.[1];
  const inFence = fenced === undefined ? null : parse(fenced);
  if (inFence) yield inFence.value;
  // Spans inside a balanced span are not tried, and only so many openers are,
  // so that a long reply cut off mid-object is not rescanned once per bracket.
  const opener = /[{[]/g;
  let attempts = 0;
  for (let match = opener.exec(text); match && attempts < 32; match = opener.exec(text)) {
    attempts++;
    const end = closingBracket(text, match.index);
    if (end < 0) continue;
    const span = parse(text.slice(match.index, end + 1));
    if (span) yield span.value;
    opener.lastIndex = end + 1;
  }
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
 *   `429`/`2003` is `rate_limited`, `400`/`7003` is `invalid_request`.
 *
 * A call's cost is read from its gateway log, which can lag the response by
 * half a second: one retry, then an estimate from the token counts and the
 * fallback prices, with a warning.
 *
 * Once a model has answered, every way out is billed: a result, a
 * `BilledModelError`, or, for a stream the consumer leaves, a report to the
 * request's billing sink.
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

  /** The call's log, read a second time when the first read has no cost yet. */
  const readLog = async (logId: string | null): Promise<GatewayLog | null> => {
    if (!logId) return null;
    let log: GatewayLog | null = null;
    for (const delay of [0, logRetryDelayMs]) {
      if (delay > 0) await sleep(delay);
      try {
        log = await ai.gateway(gatewayId).getLog(logId);
        if (typeof log.cost === "number") return log;
      } catch {
        // "Log not found" until the gateway has written it.
      }
    }
    return log;
  };

  const costOf = (
    model: string,
    usage: ModelUsage,
    logId: string | null,
    log: GatewayLog | null,
  ): MicroUsd => {
    if (typeof log?.cost === "number") return Math.round(log.cost * 1_000_000);
    const price = prices[model];
    const missing = `@gitflare/models: the gateway log ${logId ?? "(none)"} has no cost for ${model}`;
    if (!price) {
      console.warn(`${missing}, and there is no fallback price: recorded as 0`);
      return 0;
    }
    console.warn(`${missing}: estimated from the fallback prices`);
    return Math.round(
      usage.inputTokens * price.input +
        usage.outputTokens * price.output +
        usage.cacheReadTokens * price.cacheRead +
        usage.cacheWriteTokens * price.cacheWrite,
    );
  };

  const billed = async (model: string, usage: ModelUsage, logId: string | null) => ({
    model,
    usage,
    costMicroUsd: costOf(model, usage, logId, await readLog(logId)),
    gatewayLogId: logId,
  });

  const notAnthropic = async (model: string, logId: string | null) =>
    new BilledModelError(
      "unavailable",
      `${model}: the gateway did not return an Anthropic message`,
      await billed(model, emptyUsage(), logId),
    );

  const finish = async <T>(
    request: GenerateRequest<T>,
    reply: Reply,
    logId: string | null,
  ): Promise<GenerateResult<T>> => {
    const call: BilledCall = await billed(request.model, reply.usage, logId);
    if (!request.output) return { ...call, text: reply.text, output: undefined as T };

    let mismatch: string | undefined;
    for (const value of jsonCandidates(reply.text)) {
      const parsed = request.output.schema.safeParse(value);
      if (parsed.success) return { ...call, text: reply.text, output: parsed.data };
      mismatch ??= parsed.error.message;
    }
    const reason =
      reply.stopReason === "max_tokens"
        ? "it was cut off at max_tokens"
        : (mismatch ?? "it is not JSON");
    throw new BilledModelError(
      "invalid_output",
      `${request.model}: the reply is not a valid "${request.output.name}": ${reason}`,
      call,
    );
  };

  return {
    async generate<T = undefined>(request: GenerateRequest<T>): Promise<GenerateResult<T>> {
      const metadata = attributionMetadata(request.attribution);
      const { raw, logId } = await run(request.model, messagesBody(request), metadata);
      const reply = readMessage(raw);
      if (!reply) throw await notAnthropic(request.model, logId);
      return finish(request, reply, logId);
    },

    async *stream<T = undefined>(request: GenerateRequest<T>): AsyncIterable<ModelStreamEvent<T>> {
      const metadata = attributionMetadata(request.attribution);
      const body = { ...messagesBody(request), stream: true };
      const { raw, logId } = await run(request.model, body, metadata);

      if (!isReadableStream(raw)) {
        const reply = readMessage(raw);
        if (!reply) throw await notAnthropic(request.model, logId);
        const result = await finish(request, reply, logId);
        let delivered = false;
        try {
          if (reply.text) yield { type: "text", text: reply.text };
          delivered = true;
          yield { type: "done", result };
        } finally {
          if (!delivered) await reportBilled(request, result);
        }
        return;
      }

      const reply: Reply = { text: "", usage: emptyUsage(), stopReason: null };
      let started = false;
      let stopped = false;
      // Whether the stream ended in a result or an error; if not, the consumer left.
      let settled = false;
      try {
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
            } else if (type === "message_stop") {
              stopped = true;
            } else if (type === "error") {
              throw new ModelError(
                error?.type === "rate_limit_error" ? "rate_limited" : "unavailable",
                `${request.model}: ${error?.message ?? error?.type ?? "the stream failed"}`,
              );
            }
          }
        } catch (error) {
          settled = true;
          const failure = toModelError(error);
          if (!started) throw failure;
          const paid = await billed(request.model, reply.usage, logId);
          const billedFailure = new BilledModelError(failure.code, failure.message, paid);
          billedFailure.cause = failure;
          throw billedFailure;
        }
        settled = true;
        if (!started) {
          throw new ModelError("unavailable", `${request.model}: the stream carried no message`);
        }
        // A reply ends with a stop reason and `message_stop`; a stream that
        // closes before either was cut off, whatever text it carried.
        if (!stopped && reply.stopReason === null) {
          throw new BilledModelError(
            "unavailable",
            `${request.model}: the stream ended before the reply did`,
            await billed(request.model, reply.usage, logId),
          );
        }
        yield { type: "done", result: await finish(request, reply, logId) };
      } finally {
        if (!settled) await reportBilled(request, await billed(request.model, reply.usage, logId));
      }
    },

    async embed(request): Promise<EmbedResult> {
      const metadata = attributionMetadata(request.attribution);
      if (request.texts.length === 0) {
        const usage = emptyUsage();
        return { vectors: [], model: request.model, usage, costMicroUsd: 0, gatewayLogId: null };
      }
      const { raw, logId } = await run(request.model, { text: request.texts }, metadata);
      // The reply has no token counts; the log has the input's, as `tokens_in`.
      const log = await readLog(logId);
      const usage = { ...emptyUsage(), inputTokens: log?.tokens_in ?? 0 };
      const call: BilledCall = {
        model: request.model,
        usage,
        costMicroUsd: costOf(request.model, usage, logId, log),
        gatewayLogId: logId,
      };
      const embeddings = Embeddings.safeParse(raw);
      if (!embeddings.success || embeddings.data.data.length !== request.texts.length) {
        throw new BilledModelError(
          "unavailable",
          `${request.model}: the gateway did not return one vector per text`,
          call,
        );
      }
      return { vectors: embeddings.data.data, ...call };
    },
  };
}
