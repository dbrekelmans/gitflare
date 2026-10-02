import { notImplemented, type OrganisationSettings } from "@gitflare/core";
import type { Clock, IdGenerator, ModelGateway } from "@gitflare/core/ports";
import type { Db } from "@gitflare/db";

// @gitflare/models — the one typed way gitflare calls a model. The gateway
// adapter turns a `GenerateRequest` into an Anthropic Messages body for
// `env.AI.run` and back; fallback, recording and budgets are wrappers around
// the port, written here so they are tested without a gateway. Facts and
// signatures: spec/research/ai-identity.md. Build task: `models`.

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
 */
export function createGatewayModels(
  _ai: AiBindingLike,
  _options: { gatewayId: string },
): ModelGateway {
  return notImplemented("@gitflare/models createGatewayModels");
}

/**
 * Tries each fallback model in turn when a call fails with `budget_exceeded`,
 * `rate_limited` or `unavailable`. Never on `no_credits`: no other model of
 * the provider would be served either. The result's `model` says which answered.
 */
export function withFallback(_gateway: ModelGateway, _fallbacks: string[]): ModelGateway {
  return notImplemented("@gitflare/models withFallback");
}

/** Records every call in `model_calls`, with its attribution, usage and estimated cost. */
export function withAccounting(
  _gateway: ModelGateway,
  _deps: { db: Db; clock: Clock; ids: IdGenerator },
): ModelGateway {
  return notImplemented("@gitflare/models withAccounting");
}

/**
 * Refuses a call attributed to a change whose recorded spend has reached the
 * per-change budget, with `budget_exceeded`. The gateway's own spend limits
 * are windows of time and cannot express a budget per change.
 */
export function withChangeBudget(
  _gateway: ModelGateway,
  _deps: { db: Db },
  _settings: Pick<OrganisationSettings, "perChangeBudgetMicroUsd">,
): ModelGateway {
  return notImplemented("@gitflare/models withChangeBudget");
}

/** The gateway as the rest of the forge uses it: budget check, fallback and accounting, in that order. */
export function composeModels(
  _gateway: ModelGateway,
  _deps: { db: Db; clock: Clock; ids: IdGenerator },
  _settings: OrganisationSettings,
): ModelGateway {
  return notImplemented("@gitflare/models composeModels");
}

/** Cosine similarity of two vectors of the same length. */
export function cosineSimilarity(_a: number[], _b: number[]): number {
  return notImplemented("@gitflare/models cosineSimilarity");
}
