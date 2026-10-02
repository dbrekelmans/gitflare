import {
  type Change,
  type ChangeId,
  canRerunStage,
  canTransitionChange,
  ForgeError,
  isStageSettled,
  latestStageRuns,
  type StageHandler,
  type StageInput,
  type StageName,
  type StageOutcome,
  type StageRun,
  sectionForAnchor,
  stagesSettled,
  transitionChange,
  transitionStage,
} from "@gitflare/core";
import { schema, toChange, toSection } from "@gitflare/db";
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { emit, type PipelineDeps, requireChange } from "./deps";

const { changeCommits, changes, sections, stageRuns, threads } = schema;

type StageDeps = Pick<PipelineDeps, "db" | "live" | "clock">;
type Settlement = StageOutcome | { status: "failed"; reason: string };

/** How long the pipeline waits for the checkpoints a push's commits name before going on without them. */
export const CHECKPOINT_WAIT_MS = 60_000;
export const CHECKPOINT_POLL_MS = 5_000;

/**
 * The checkpoints the change's commits name that have not arrived. The
 * pipeline polls this for `CHECKPOINT_WAIT_MS` before it runs the stages.
 */
export async function missingCheckpoints(
  deps: Pick<PipelineDeps, "db" | "capture">,
  changeId: ChangeId,
): Promise<string[]> {
  const commits = await deps.db
    .select({ checkpointIds: changeCommits.checkpointIds })
    .from(changeCommits)
    .where(eq(changeCommits.changeId, changeId));
  const named = new Set(commits.flatMap((entry) => entry.checkpointIds));
  if (named.size === 0) return [];
  return (await deps.capture.missingCheckpoints(changeId)).filter((id) => named.has(id));
}

async function loadRun(deps: StageDeps, input: StageInput): Promise<StageRun> {
  const [run] = await deps.db.select().from(stageRuns).where(eq(stageRuns.id, input.stageRunId));
  if (!run) throw new ForgeError("not_found", `Stage run ${input.stageRunId} not found.`);
  return run;
}

function announce(deps: StageDeps, run: StageRun) {
  const { stage, attempt, status, reason } = run;
  return emit(deps, run.changeId, { type: "stage.status", stage, attempt, status, reason });
}

/**
 * Moves a run on, unless something else already has: the update only applies
 * to the status the caller read, so two deliveries of one step announce a
 * transition once.
 */
async function advance(
  deps: StageDeps,
  run: StageRun,
  next: Pick<StageRun, "status" | "reason" | "startedAt" | "finishedAt">,
): Promise<StageRun> {
  const [moved] = await deps.db
    .update(stageRuns)
    .set(next)
    .where(and(eq(stageRuns.id, run.id), eq(stageRuns.status, run.status)))
    .returning();
  if (!moved) return loadRun(deps, { ...run, stageRunId: run.id });
  await announce(deps, moved);
  return moved;
}

function begin(deps: StageDeps, run: StageRun): Promise<StageRun> {
  return advance(deps, run, {
    status: transitionStage(run.status, "start"),
    reason: null,
    startedAt: deps.clock.now(),
    finishedAt: null,
  });
}

function settle(deps: StageDeps, run: StageRun, outcome: Settlement): Promise<StageRun> {
  const event =
    outcome.status === "succeeded" ? "succeed" : outcome.status === "skipped" ? "skip" : "fail";
  return advance(deps, run, {
    status: transitionStage(run.status, event),
    reason: outcome.status === "succeeded" ? null : outcome.reason,
    // A skipped stage did no work, whether or not its handler was asked.
    startedAt: outcome.status === "skipped" ? null : run.startedAt,
    finishedAt: deps.clock.now(),
  });
}

/** Marks a queued attempt as running: for a stage whose work happens elsewhere, as CI's does. */
export async function startStage(deps: StageDeps, input: StageInput): Promise<StageRun> {
  const run = await loadRun(deps, input);
  return run.status === "queued" ? begin(deps, run) : run;
}

/**
 * Runs one stage attempt around its handler: marks it running, calls the
 * handler, records the outcome or the failure, and emits `stage.status` for
 * each transition. Never throws for a failing handler; the returned run says
 * what happened.
 *
 * An attempt that already settled is returned as it is. One found running is
 * run again: that is a Workflow step retried after it died half way, which is
 * why handlers must be idempotent.
 */
export async function runStage<Deps>(
  deps: PipelineDeps,
  handler: StageHandler<Deps>,
  handlerDeps: Deps,
  input: StageInput & { stage: StageName },
): Promise<StageRun> {
  const run = await startStage(deps, input);
  if (run.stage !== input.stage) {
    throw new Error(`stage run ${run.id} is a ${run.stage} run, not ${input.stage}`);
  }
  if (isStageSettled(run.status)) return run;
  let outcome: Settlement;
  try {
    const { changeId, revisionId, stageRunId, attempt } = input;
    outcome = await handler(handlerDeps, { changeId, revisionId, stageRunId, attempt });
  } catch (error) {
    outcome = { status: "failed", reason: error instanceof Error ? error.message : String(error) };
  }
  return settle(deps, run, outcome);
}

/** Records an outcome reported from elsewhere: the CI Workflow's, when it finishes. */
export async function recordStageOutcome(
  deps: PipelineDeps,
  input: StageInput,
  outcome: StageOutcome | { status: "failed"; reason: string },
): Promise<StageRun> {
  let run = await loadRun(deps, input);
  if (isStageSettled(run.status)) return run;
  // Only work that started can succeed; skipping and failing need no start.
  if (run.status === "queued" && outcome.status === "succeeded") run = await begin(deps, run);
  if (isStageSettled(run.status)) return run;
  return settle(deps, run, outcome);
}

/**
 * Called when stages settle: places review comments in their sections, moves
 * the change to `ready` if every stage of its head revision has settled, and
 * emits `change.status`. Safe to call after every stage.
 */
export async function settleChange(deps: PipelineDeps, changeId: ChangeId): Promise<Change> {
  const { db } = deps;
  const change = await requireChange(db, changeId);

  const current = await db
    .select()
    .from(sections)
    .where(and(eq(sections.changeId, changeId), isNull(sections.removedAt)));
  if (current.length > 0) {
    const unplaced = await db
      .select({ id: threads.id, anchor: threads.anchor })
      .from(threads)
      .where(
        and(eq(threads.changeId, changeId), isNull(threads.sectionId), isNotNull(threads.anchor)),
      );
    for (const thread of unplaced) {
      const sectionId = thread.anchor && sectionForAnchor(current.map(toSection), thread.anchor);
      if (!sectionId) continue;
      await db
        .update(threads)
        .set({ sectionId })
        .where(and(eq(threads.id, thread.id), isNull(threads.sectionId)));
    }
  }

  if (!canTransitionChange(change.status, "stages_settled")) return toChange(change);
  const runs = await db
    .select()
    .from(stageRuns)
    .where(eq(stageRuns.revisionId, change.headRevisionId));
  if (!stagesSettled(runs)) return toChange(change);

  const status = transitionChange(change.status, "stages_settled");
  // Not if a push or a re-run got in first: the head or the status moved, and this is stale.
  const [ready] = await db
    .update(changes)
    .set({ status, readyAt: deps.clock.now() })
    .where(
      and(
        eq(changes.id, changeId),
        eq(changes.status, change.status),
        eq(changes.headRevisionId, change.headRevisionId),
      ),
    )
    .returning();
  if (!ready) return toChange(await requireChange(db, changeId));
  await emit(deps, changeId, { type: "change.status", status });
  return toChange(ready);
}

/**
 * Queues a new attempt of a settled stage and moves the change back to
 * `processing`. An attempt already queued is returned as it is, so the call
 * is safe to repeat; a running one is a `conflict`.
 */
export async function queueStageRerun(
  deps: PipelineDeps,
  changeId: ChangeId,
  stage: StageName,
): Promise<StageRun> {
  const { db } = deps;
  const change = await requireChange(db, changeId);
  const newest = async () =>
    latestStageRuns(
      await db.select().from(stageRuns).where(eq(stageRuns.revisionId, change.headRevisionId)),
    )[stage];

  const latest = await newest();
  if (!latest) throw new ForgeError("not_found", `The change has no ${stage} stage to re-run.`);
  if (latest.status === "queued") return latest;
  if (!canRerunStage(latest.status)) {
    throw new ForgeError("conflict", `The ${stage} stage is already ${latest.status}.`);
  }
  if (!canTransitionChange(change.status, "stage_rerun")) {
    throw new ForgeError("conflict", `A ${change.status} change cannot re-run a stage.`);
  }

  const run: StageRun = {
    id: deps.ids.next("stageRun"),
    changeId,
    revisionId: change.headRevisionId,
    stage,
    attempt: latest.attempt + 1,
    status: "queued",
    reason: null,
    startedAt: null,
    finishedAt: null,
  };
  const status = transitionChange(change.status, "stage_rerun");
  try {
    await db.batch([
      db.insert(stageRuns).values(run),
      db
        .update(changes)
        .set({ status })
        .where(and(eq(changes.id, changeId), eq(changes.status, change.status))),
    ]);
  } catch (error) {
    // Two requests for the same re-run: the attempt number is unique, and the other one has it.
    const winner = await newest();
    if (winner?.attempt === run.attempt && winner.status === "queued") return winner;
    throw error;
  }
  await announce(deps, run);
  if (status !== change.status) await emit(deps, changeId, { type: "change.status", status });
  return run;
}
