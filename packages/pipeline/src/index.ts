import {
  type Change,
  type ChangeId,
  notImplemented,
  type Push,
  type PushKind,
  type RevisionId,
  type Session,
  type SessionId,
  type StageHandler,
  type StageInput,
  type StageName,
  type StageOutcome,
  type StageRun,
  type User,
} from "@gitflare/core";
import type {
  CapturePort,
  ChangeLive,
  Clock,
  DecisionsPort,
  DiffPort,
  GitHost,
  GitWriter,
  IdGenerator,
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
  capture: CapturePort;
  diffs: DiffPort;
  decisions: DecisionsPort;
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
 * change or adds a revision (filling each commit's `checkpointIds` with
 * `parseCheckpointTrailers`), and creates the head revision's stage runs. For
 * a checkpoint ref it records the new tip. Events come one per ref and can
 * arrive out of order, so this reads the ref's current tip rather than trust
 * the event's `after`, and the same or an older push delivered again yields
 * the same result.
 */
export async function handlePush(_deps: PipelineDeps, _push: Push): Promise<PushResult> {
  return notImplemented("@gitflare/pipeline handlePush");
}

export type { PushKind };

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
 * the change as it was. On success it records the merge, settles the change's
 * decisions and ends the session.
 */
export async function mergeChange(
  _deps: PipelineDeps,
  _user: User,
  _changeId: ChangeId,
): Promise<Change> {
  return notImplemented("@gitflare/pipeline mergeChange");
}

/** Closes a change without merging and ends its session. */
export async function closeChange(
  _deps: PipelineDeps,
  _user: User,
  _changeId: ChangeId,
): Promise<Change> {
  return notImplemented("@gitflare/pipeline closeChange");
}

/**
 * Ends a session, in the one place that does: marks it merged or abandoned,
 * deletes its fork from the git host (which revokes the fork's tokens) and
 * records that the fork is gone. `mergeChange` and `closeChange` call it; so
 * does abandoning a session that never opened a change. Safe to call twice.
 */
export async function endSession(
  _deps: Pick<PipelineDeps, "db" | "git" | "clock">,
  _sessionId: SessionId,
  _outcome: "merged" | "abandoned",
): Promise<Session> {
  return notImplemented("@gitflare/pipeline endSession");
}
