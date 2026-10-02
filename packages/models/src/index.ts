import {
  type BudgetSummary,
  type ChangeCost,
  type ChangeId,
  notImplemented,
  type OrganisationSettings,
} from "@gitflare/core";
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

/** The `ModelGateway` port over the AI binding and one named gateway. */
export function createGatewayModels(
  _ai: AiBindingLike,
  _options: { gatewayId: string },
): ModelGateway {
  return notImplemented("@gitflare/models createGatewayModels");
}

/**
 * Tries each fallback model in turn when a call fails with `budget_exceeded`,
 * `rate_limited` or `unavailable`. The result's `model` says which answered.
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

export async function changeCost(_db: Db, _changeId: ChangeId): Promise<ChangeCost> {
  return notImplemented("@gitflare/models changeCost");
}

export async function budgetSummary(
  _deps: { db: Db; clock: Clock },
  _settings: OrganisationSettings,
): Promise<BudgetSummary> {
  return notImplemented("@gitflare/models budgetSummary");
}

/** Cosine similarity of two vectors of the same length. */
export function cosineSimilarity(_a: number[], _b: number[]): number {
  return notImplemented("@gitflare/models cosineSimilarity");
}
