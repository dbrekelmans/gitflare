import type { z } from "zod";
import type { ModelAttribution, ModelUsage } from "../domain/model-call";
import type { MicroUsd } from "../ids";

export interface ModelMessage {
  role: "user" | "assistant";
  content: string;
}

export interface GenerateRequest<T> {
  /** A gateway catalog id such as `anthropic/claude-sonnet-5`. */
  model: string;
  system?: string;
  messages: ModelMessage[];
  maxOutputTokens: number;
  attribution: ModelAttribution;
  /**
   * Ask for JSON matching this schema. The result's `output` is parsed and
   * validated; a response that does not validate is a `ModelError`, not a
   * malformed value.
   */
  output?: { name: string; schema: z.ZodType<T> };
}

export interface GenerateResult<T> {
  /** The validated object when `output` was requested; otherwise undefined. */
  output: T;
  text: string;
  /** The model that answered. */
  model: string;
  usage: ModelUsage;
  /** An estimate. */
  costMicroUsd: MicroUsd;
  gatewayLogId: string | null;
}

export type ModelStreamEvent<T> =
  | { type: "text"; text: string }
  | { type: "done"; result: GenerateResult<T> };

export interface EmbedResult {
  /** One vector per input text, in order. */
  vectors: number[][];
  model: string;
  /** What the call consumed. An embedding has input tokens only. */
  usage: ModelUsage;
  costMicroUsd: MicroUsd;
  gatewayLogId: string | null;
}

export type ModelErrorCode =
  /** The gateway refused the call because a budget is spent. */
  | "budget_exceeded"
  /**
   * The deployment has neither prepaid gateway credits nor a stored provider
   * key, so no call to this provider can succeed until its owner adds one.
   * Not retryable and not a reason to fall back to another model of the same
   * provider.
   */
  | "no_credits"
  | "rate_limited"
  /**
   * The gateway refused the request itself: an unknown model, a malformed
   * body. Sending it again, to this model or a fallback, fails the same way.
   */
  | "invalid_request"
  /** The model answered, but not with what was asked for. */
  | "invalid_output"
  | "unavailable";

export class ModelError extends Error {
  constructor(
    readonly code: ModelErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ModelError";
  }
}

/**
 * One call to one model through the deployment's gateway. This is the whole
 * surface the gateway is allowed to have in gitflare's code. Every call bypasses
 * the gateway's response cache, which is otherwise on even at a zero lifetime
 * and would hand one caller another's reply. Choosing a
 * fallback model, recording the call, and enforcing a per-change budget are
 * wrappers around this interface in `@gitflare/models`, not part of it.
 */
export interface ModelGateway {
  generate<T = undefined>(request: GenerateRequest<T>): Promise<GenerateResult<T>>;
  stream<T = undefined>(request: GenerateRequest<T>): AsyncIterable<ModelStreamEvent<T>>;
  embed(request: {
    model: string;
    texts: string[];
    attribution: ModelAttribution;
  }): Promise<EmbedResult>;
}
