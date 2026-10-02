import type { AgentName, ModelAttribution } from "@gitflare/core";
import {
  type EmbedResult,
  type GenerateRequest,
  type GenerateResult,
  ModelError,
  type ModelErrorCode,
  type ModelGateway,
  type ModelStreamEvent,
} from "@gitflare/core/ports";

/** What a scripted reply provides; everything else about the result is filled in. */
export type ScriptedReply =
  | { text: string }
  /** The object the model "returned". It is validated against the request's schema like a real one. */
  | { output: unknown }
  | { error: ModelErrorCode };

type Responder = (request: GenerateRequest<unknown>) => ScriptedReply | undefined;

const DIMENSIONS = 32;

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

/**
 * A unit vector from the words of a text. Texts that share words come out
 * close, which is enough for retrieval tests to mean something.
 */
export function fakeEmbedding(text: string): number[] {
  const vector = new Array<number>(DIMENSIONS).fill(0);
  for (const word of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    const slot = hash(word) % DIMENSIONS;
    vector[slot] = (vector[slot] ?? 0) + 1;
  }
  const length = Math.hypot(...vector) || 1;
  return vector.map((value) => value / length);
}

/**
 * A model gateway that answers from a script. Register replies per agent with
 * `reply`, or for anything with `respond`; a call nothing answers fails the
 * test with a clear message rather than inventing a response.
 *
 * Token counts and cost are derived from text length, so cost accounting has
 * non-zero, deterministic numbers to add up.
 */
export class FakeModelGateway implements ModelGateway {
  /** Every generate and stream request, in order. */
  readonly calls: GenerateRequest<unknown>[] = [];
  readonly embedCalls: { model: string; texts: string[]; attribution: ModelAttribution }[] = [];
  private readonly responders: Responder[] = [];
  private readonly queues = new Map<AgentName, ScriptedReply[]>();
  private readonly unavailable = new Map<string, ModelErrorCode>();

  /** Queues one reply for the next call attributed to `agent`. */
  reply(agent: AgentName, reply: ScriptedReply): this {
    const queue = this.queues.get(agent) ?? [];
    queue.push(reply);
    this.queues.set(agent, queue);
    return this;
  }

  /** Registers a responder for any request. Later registrations are asked first. */
  respond(responder: Responder): this {
    this.responders.unshift(responder);
    return this;
  }

  /** Makes every call to `model` fail with `code`, to exercise fallback. */
  fail(model: string, code: ModelErrorCode = "budget_exceeded"): this {
    this.unavailable.set(model, code);
    return this;
  }

  async generate<T = undefined>(request: GenerateRequest<T>): Promise<GenerateResult<T>> {
    this.calls.push(request as GenerateRequest<unknown>);
    const failure = this.unavailable.get(request.model);
    if (failure) throw new ModelError(failure, `${request.model}: scripted ${failure}`);
    const reply = this.next(request as GenerateRequest<unknown>);
    if ("error" in reply) throw new ModelError(reply.error, `scripted ${reply.error}`);

    let output: unknown;
    let text: string;
    if ("output" in reply) {
      text = JSON.stringify(reply.output);
      const parsed = request.output?.schema.safeParse(reply.output);
      if (parsed && !parsed.success) throw new ModelError("invalid_output", parsed.error.message);
      output = parsed ? parsed.data : undefined;
    } else {
      text = reply.text;
      if (request.output) throw new ModelError("invalid_output", "expected structured output");
    }

    const input = request.messages.map((m) => m.content).join("") + (request.system ?? "");
    const usage = {
      inputTokens: Math.ceil(input.length / 4),
      outputTokens: Math.ceil(text.length / 4),
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
    return {
      output: output as T,
      text,
      model: request.model,
      usage,
      costMicroUsd: usage.inputTokens * 2 + usage.outputTokens * 10,
      gatewayLogId: `log_${this.calls.length}`,
    };
  }

  async *stream<T = undefined>(request: GenerateRequest<T>): AsyncIterable<ModelStreamEvent<T>> {
    const result = await this.generate(request);
    for (const word of result.text.match(/\S+\s*/g) ?? []) yield { type: "text", text: word };
    yield { type: "done", result };
  }

  async embed(request: {
    model: string;
    texts: string[];
    attribution: ModelAttribution;
  }): Promise<EmbedResult> {
    this.embedCalls.push(request);
    return {
      vectors: request.texts.map(fakeEmbedding),
      model: request.model,
      costMicroUsd: request.texts.join("").length,
    };
  }

  private next(request: GenerateRequest<unknown>): ScriptedReply {
    const queued = this.queues.get(request.attribution.agent)?.shift();
    if (queued) return queued;
    for (const responder of this.responders) {
      const reply = responder(request);
      if (reply) return reply;
    }
    throw new Error(
      `FakeModelGateway: no reply scripted for a "${request.attribution.agent}" call to ${request.model}`,
    );
  }
}

type JsonSchema = {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: unknown[];
  const?: unknown;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  minItems?: number;
  minimum?: number;
};

/** The smallest value a JSON schema accepts, more or less: enough for a placeholder reply. */
function sample(schema: JsonSchema): unknown {
  if (schema.const !== undefined) return schema.const;
  if (schema.enum) return schema.enum[0];
  const variant = schema.anyOf?.[0] ?? schema.oneOf?.[0];
  if (variant) return sample(variant);
  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  switch (type) {
    case "object":
      return Object.fromEntries(
        (schema.required ?? []).map((key) => [key, sample(schema.properties?.[key] ?? {})]),
      );
    case "array":
      return Array.from({ length: schema.minItems ?? 0 }, () => sample(schema.items ?? {}));
    case "number":
    case "integer":
      return schema.minimum ?? 0;
    case "boolean":
      return false;
    case "null":
      return null;
    default:
      return "Placeholder from the local model fake.";
  }
}

/**
 * A responder that answers anything: a structured request gets the smallest
 * object its schema accepts, a plain one gets a line of text. Local
 * development registers it so the pipeline runs end to end without a model;
 * tests should script real replies instead.
 */
export function placeholderResponder(toJsonSchema: (schema: never) => unknown) {
  return (request: GenerateRequest<unknown>): ScriptedReply =>
    request.output
      ? { output: sample(toJsonSchema(request.output.schema as never) as JsonSchema) }
      : { text: "This is a placeholder reply from the local model fake." };
}
