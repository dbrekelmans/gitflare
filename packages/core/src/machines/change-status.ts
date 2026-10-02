import type { ChangeStatus, StageName, StageRun, StageStatus } from "../domain/change";
import { stageNames } from "../domain/change";

export class InvalidTransitionError extends Error {
  constructor(
    readonly machine: string,
    readonly from: string,
    readonly event: string,
  ) {
    super(`${machine}: cannot apply "${event}" in state "${from}"`);
    this.name = "InvalidTransitionError";
  }
}

// --- Stages ---------------------------------------------------------------

export type StageEvent = "start" | "succeed" | "fail" | "skip";

const stageTransitions: Record<StageStatus, Partial<Record<StageEvent, StageStatus>>> = {
  queued: { start: "running", skip: "skipped", fail: "failed" },
  running: { succeed: "succeeded", fail: "failed", skip: "skipped" },
  succeeded: {},
  failed: {},
  skipped: {},
};

/** A settled attempt never changes. Running a stage again is a new attempt, starting at `queued`. */
export function transitionStage(status: StageStatus, event: StageEvent): StageStatus {
  const next = stageTransitions[status][event];
  if (!next) throw new InvalidTransitionError("stage", status, event);
  return next;
}

export function isStageSettled(status: StageStatus): boolean {
  return status === "succeeded" || status === "failed" || status === "skipped";
}

/** Only a settled stage can be re-run; a queued or running one already is. */
export function canRerunStage(status: StageStatus): boolean {
  return isStageSettled(status);
}

/** The newest attempt of each stage, from the runs of one revision. */
export function latestStageRuns(runs: readonly StageRun[]): Partial<Record<StageName, StageRun>> {
  const latest: Partial<Record<StageName, StageRun>> = {};
  for (const run of runs) {
    const current = latest[run.stage];
    if (!current || run.attempt > current.attempt) latest[run.stage] = run;
  }
  return latest;
}

/** True once every stage has a newest attempt and all of them are settled. */
export function stagesSettled(runs: readonly StageRun[]): boolean {
  const latest = latestStageRuns(runs);
  return stageNames.every((stage) => {
    const run = latest[stage];
    return run !== undefined && isStageSettled(run.status);
  });
}

// --- Change lifecycle -----------------------------------------------------

export type ChangeLifecycleEvent =
  /** A new head arrived on the change's branch. */
  | "revision_pushed"
  /** The pipeline created the head revision's stage runs. */
  | "pipeline_started"
  /** Every stage of the head revision settled, whatever the outcomes. */
  | "stages_settled"
  /** Someone re-ran a settled stage. */
  | "stage_rerun"
  | "merged"
  | "closed";

const changeTransitions: Record<
  ChangeStatus,
  Partial<Record<ChangeLifecycleEvent, ChangeStatus>>
> = {
  open: { pipeline_started: "processing", revision_pushed: "open", closed: "closed" },
  processing: {
    stages_settled: "ready",
    revision_pushed: "open",
    // A second stage re-run while the first is still going.
    stage_rerun: "processing",
    closed: "closed",
  },
  ready: {
    stage_rerun: "processing",
    revision_pushed: "open",
    merged: "merged",
    closed: "closed",
  },
  merged: {},
  closed: {},
};

export function transitionChange(status: ChangeStatus, event: ChangeLifecycleEvent): ChangeStatus {
  const next = changeTransitions[status][event];
  if (!next) throw new InvalidTransitionError("change", status, event);
  return next;
}

export function canTransitionChange(status: ChangeStatus, event: ChangeLifecycleEvent): boolean {
  return changeTransitions[status][event] !== undefined;
}

/**
 * The status a change should have, from the facts. The pipeline uses the
 * transitions above as it goes; this is the same answer computed from scratch,
 * for repair and for tests.
 */
export function deriveChangeStatus(facts: {
  merged: boolean;
  closed: boolean;
  /** Stage runs of the head revision only. */
  headStageRuns: readonly StageRun[];
}): ChangeStatus {
  if (facts.merged) return "merged";
  if (facts.closed) return "closed";
  if (facts.headStageRuns.length === 0) return "open";
  return stagesSettled(facts.headStageRuns) ? "ready" : "processing";
}
