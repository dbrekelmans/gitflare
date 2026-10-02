import type { DecisionEventKind, DecisionStatus } from "../domain/decision";

/**
 * How a decision's strength moves. It is reinforced when later work follows
 * it, a reviewer cites it, or a conversation confirms it. It is weakened only
 * when a change goes against it and is merged anyway. Nothing here takes a
 * clock: a rule that rarely comes up keeps its strength until the repository
 * actually contradicts it.
 */
export const decisionStrength = {
  initial: 0.5,
  /** Below this a decision is dormant: kept, shown, but not given to the reviewing agent. */
  dormantBelow: 0.2,
  /** The share of the remaining distance to 1 that each reinforcement closes. */
  gain: { followed: 0.1, cited: 0.15, confirmed: 0.25 },
  /** What an accepted contradiction multiplies strength by. */
  contradictionFactor: 0.6,
} as const;

export interface DecisionStrengthState {
  strength: number;
  status: DecisionStatus;
}

function statusFor(strength: number): DecisionStatus {
  return strength < decisionStrength.dormantBelow ? "dormant" : "active";
}

function reinforce(strength: number, gain: number): number {
  return strength + (1 - strength) * gain;
}

export function initialDecisionState(): DecisionStrengthState {
  return { strength: decisionStrength.initial, status: "active" };
}

/**
 * Applies one event. `reshaped` and `reverted` change the wording, not the
 * strength. `revived` is a person bringing a dormant decision back: it returns
 * to the initial strength, or keeps its own if that is higher.
 */
export function applyDecisionEvent(
  state: DecisionStrengthState,
  kind: DecisionEventKind,
): DecisionStrengthState {
  let strength = state.strength;
  switch (kind) {
    case "created":
      strength = decisionStrength.initial;
      break;
    case "followed":
      strength = reinforce(strength, decisionStrength.gain.followed);
      break;
    case "cited":
      strength = reinforce(strength, decisionStrength.gain.cited);
      break;
    case "confirmed":
      strength = reinforce(strength, decisionStrength.gain.confirmed);
      break;
    case "contradiction_accepted":
      strength = strength * decisionStrength.contradictionFactor;
      break;
    case "revived":
      strength = Math.max(strength, decisionStrength.initial);
      break;
    case "reshaped":
    case "reverted":
      break;
  }
  strength = Math.min(1, Math.max(0, strength));
  return { strength, status: statusFor(strength) };
}

/** Only active decisions are retrieved for a review. */
export function isRetrievable(state: DecisionStrengthState): boolean {
  return state.status === "active";
}
