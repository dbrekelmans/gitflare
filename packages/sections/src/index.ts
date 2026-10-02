import { type FileDiff, notImplemented, type Section, type StageHandler } from "@gitflare/core";
import type { Clock, GitHost, IdGenerator, ModelGateway } from "@gitflare/core/ports";
import type { Db } from "@gitflare/db";

// @gitflare/sections — dividing one change into sections a person can read
// and approve in order: behaviour first, mechanical changes grouped apart,
// each with an explanation written from the transcript and the code.
// Build task: `sections`.

export interface SectionsDeps {
  db: Db;
  git: GitHost;
  models: ModelGateway;
  clock: Clock;
  ids: IdGenerator;
}

/**
 * The sectioning stage. On a change's first revision it divides the diff. On a
 * later one it folds the new diff into the sections that exist, withdraws the
 * approvals of the sections whose content changed (`approvalsWithdrawnByPush`),
 * and emits the events for both.
 */
export const runSectionsStage: StageHandler<SectionsDeps> = async () =>
  notImplemented("@gitflare/sections runSectionsStage");

export interface FoldResult {
  /** Every section after the fold, in reading order. Untouched sections are returned unchanged. */
  sections: Section[];
  /** Hunks that fit no existing section; the caller asks the model where they belong. */
  unplaced: FileDiff[];
}

/**
 * Folds a new revision's diff into existing sections without consulting a
 * model: a section keeps its files, its `contentHash` is recomputed, and a
 * section left with nothing to show is dropped. Pure, so the rule that decides
 * which approvals survive a push is testable on its own.
 */
export function foldRevision(_existing: Section[], _diff: FileDiff[]): FoldResult {
  return notImplemented("@gitflare/sections foldRevision");
}
