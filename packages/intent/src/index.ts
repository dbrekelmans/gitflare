import { type Intent, notImplemented, type StageHandler } from "@gitflare/core";
import type { CapturePort, Clock, DiffPort, IdGenerator, ModelGateway } from "@gitflare/core/ports";
import type { Db } from "@gitflare/db";

// @gitflare/intent — what a change is for, derived from the session that
// produced it. Runs once, when the change opens; with a transcript the intent
// is graded `transcript`, without one it is derived from the diff alone and
// graded `diff`. It never refuses: a vague intent is still an intent.
// Build task: `intent`. Prototype to port: prototypes/derivation/src/derive.ts.

export interface IntentDeps {
  db: Db;
  capture: CapturePort;
  diffs: DiffPort;
  models: ModelGateway;
  clock: Clock;
  ids: IdGenerator;
}

/**
 * The intent stage. Skips, with a reason, on a later revision of a change that
 * already has an intent, unless this attempt is a re-run someone asked for.
 */
export const runIntentStage: StageHandler<IntentDeps> = async () =>
  notImplemented("@gitflare/intent runIntentStage");

/** The change's current intent: the highest version. */
export async function currentIntent(
  _deps: Pick<IntentDeps, "db">,
  _changeId: Intent["changeId"],
): Promise<Intent | null> {
  return notImplemented("@gitflare/intent currentIntent");
}
