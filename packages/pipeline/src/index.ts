import {
  type Change,
  type ChangeId,
  notImplemented,
  type Push,
  type PushKind,
  type RevisionId,
  type StageHandler,
  type StageInput,
  type StageName,
  type StageOutcome,
  type StageRun,
  type User,
} from "@gitflare/core";
import type {
  ChangeLive,
  Clock,
  GitHost,
  GitWriter,
  IdGenerator,
  ModelGateway,
} from "@gitflare/core/ports";
import type { Db } from "@gitflare/db";

// @gitflare/pipeline — the life of a change from push to merge, as plain
// functions. The change-pipeline Workflow in
// `apps/forge/src/server/workflows/change-pipeline.ts` calls them one Workflow
// step at a time; nothing here knows it is running in a Workflow, and every
// function is safe to run twice. Build task: `pipeline`.

export interface PipelineDeps {
  db: Db;
  git: GitHost;
  gitWriter: GitWriter;
  models: ModelGateway;
  live: ChangeLive;
  clock: Clock;
  ids: IdGenerator;
}

export type PushResult =
  /** The push opened a change or added a revision; its stages are queued. */
  | {
      kind: "change";
      changeId: ChangeId;
      revisionId: RevisionId;
      opened: boolean;
      stages: StageRun[];
    }
  | { kind: "checkpoint"; checkpointId: string }
  | { kind: "ignored"; reason: string };

/**
 * Reacts to one push. For a session's branch it re-reads the commit range
 * from the fork (the event's own commit list can be truncated), opens the
 * change or adds a revision, and creates the head revision's stage runs. For
 * a checkpoint ref it records the new tip. The same push delivered twice
 * yields the same result.
 */
export async function handlePush(_deps: PipelineDeps, _push: Push): Promise<PushResult> {
  return notImplemented("@gitflare/pipeline handlePush");
}

export type { PushKind };

/**
 * True once every checkpoint the head revision's commits name has arrived.
 * The capture client pushes checkpoints before code but fails soft, so the
 * pipeline waits a short while and then goes on without them.
 */
export async function checkpointsArrived(
  _deps: Pick<PipelineDeps, "db">,
  _changeId: ChangeId,
): Promise<boolean> {
  return notImplemented("@gitflare/pipeline checkpointsArrived");
}

/**
 * Runs one stage attempt around its handler: marks it running, calls the
 * handler, records the outcome or the failure, and emits `stage.status` for
 * each transition. Never throws for a failing handler; the returned run says
 * what happened.
 */
export async function runStage<Deps>(
  _deps: PipelineDeps,
  _handler: StageHandler<Deps>,
  _handlerDeps: Deps,
  _input: StageInput & { stage: StageName },
): Promise<StageRun> {
  return notImplemented("@gitflare/pipeline runStage");
}

/** Records an outcome reported from elsewhere: the CI Workflow's, when it finishes. */
export async function recordStageOutcome(
  _deps: PipelineDeps,
  _input: StageInput,
  _outcome: StageOutcome | { status: "failed"; reason: string },
): Promise<StageRun> {
  return notImplemented("@gitflare/pipeline recordStageOutcome");
}

/**
 * Called when stages settle: places review comments in their sections, moves
 * the change to `ready` if every stage of its head revision has settled, and
 * emits `change.status`. Safe to call after every stage.
 */
export async function settleChange(_deps: PipelineDeps, _changeId: ChangeId): Promise<Change> {
  return notImplemented("@gitflare/pipeline settleChange");
}

/** Queues a new attempt of a settled stage and moves the change back to `processing`. */
export async function queueStageRerun(
  _deps: PipelineDeps,
  _changeId: ChangeId,
  _stage: StageName,
): Promise<StageRun> {
  return notImplemented("@gitflare/pipeline queueStageRerun");
}

/**
 * Merges a ready change into the main repo. Checks `mergeReadiness` first and
 * fails with `not_ready`; a merge conflict fails with `conflict` and leaves
 * the change as it was. On success it records the merge, ends the session,
 * settles the change's decisions and deletes the fork.
 */
export async function mergeChange(
  _deps: PipelineDeps,
  _user: User,
  _changeId: ChangeId,
): Promise<Change> {
  return notImplemented("@gitflare/pipeline mergeChange");
}

/** Closes a change without merging, ends its session and deletes the fork. */
export async function closeChange(
  _deps: PipelineDeps,
  _user: User,
  _changeId: ChangeId,
): Promise<Change> {
  return notImplemented("@gitflare/pipeline closeChange");
}
