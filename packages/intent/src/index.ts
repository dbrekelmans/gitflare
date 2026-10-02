import { forkRepoName, type Intent, type IntentGrade, type StageHandler } from "@gitflare/core";
import type {
  CapturePort,
  ChangeLive,
  Clock,
  DiffPort,
  IdGenerator,
  ModelGateway,
} from "@gitflare/core/ports";
import { type Db, schema } from "@gitflare/db";
import { desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { buildIntentPrompt } from "./prompt";

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
  live: ChangeLive;
  clock: Clock;
  ids: IdGenerator;
}

const intentOutput = z.object({ statement: z.string().trim().min(1) });

const SKIP_REASON = "Intent is derived once, when the change opens.";

/**
 * The intent stage. Skips, with a reason, on a later revision of a change that
 * already has an intent, unless this attempt is a re-run someone asked for.
 *
 * `attempt` is scoped to this revision and stage (`stage_runs_attempt`): the
 * pipeline always queues attempt 1 automatically when a revision's stage runs
 * are created, and only a requested re-run (`rerunStage`, always against the
 * change's head revision) queues attempt 2 or later. That makes `attempt`,
 * not whether `revisionId` matches the existing intent, what tells a later
 * revision's first (and only ever skipped) attempt apart from a re-run.
 */
export const runIntentStage: StageHandler<IntentDeps> = async (deps, input) => {
  const { changeId, revisionId, attempt } = input;

  const [change] = await deps.db
    .select()
    .from(schema.changes)
    .where(eq(schema.changes.id, changeId));
  if (!change) throw new Error(`intent stage: change ${changeId} does not exist`);

  const latest = await currentIntent(deps, changeId);
  if (attempt === 1) {
    // Idempotent: a Workflow retry of the attempt that already wrote this
    // revision's intent lands here again and does nothing further.
    if (latest?.revisionId === revisionId) return { status: "succeeded" };
    // A later revision's automatic first attempt, with the intent already
    // derived (on an earlier revision, necessarily): intent runs once.
    if (latest) return { status: "skipped", reason: SKIP_REASON };
  }
  // attempt > 1 is a requested re-run and always derives a fresh intent. A
  // Workflow retry of the *same* re-run attempt can still add a duplicate
  // version: telling it apart from a second, deliberate re-run needs `intents`
  // to record which attempt produced a version, a column this package cannot
  // add on its own (`packages/db` is shared, frozen scaffold) — see the pull
  // request, which asks for it.

  const [repository] = await deps.db
    .select()
    .from(schema.repositories)
    .where(eq(schema.repositories.id, change.repositoryId));
  if (!repository)
    throw new Error(`intent stage: repository ${change.repositoryId} does not exist`);

  const [organisation] = await deps.db
    .select()
    .from(schema.organisations)
    .where(eq(schema.organisations.id, repository.organisationId));
  if (!organisation) {
    throw new Error(`intent stage: organisation ${repository.organisationId} does not exist`);
  }

  const [revision] = await deps.db
    .select()
    .from(schema.revisions)
    .where(eq(schema.revisions.id, revisionId));
  if (!revision) throw new Error(`intent stage: revision ${revisionId} does not exist`);

  const [capture, diff] = await Promise.all([
    deps.capture.read(changeId),
    deps.diffs.between(
      forkRepoName(repository.slug, change.sessionId),
      revision.baseSha,
      revision.headSha,
    ),
  ]);

  const grade: IntentGrade = capture.sessions.length > 0 ? "transcript" : "diff";
  const checkpointIds = capture.sessions.flatMap((session) => session.checkpointIds);

  const prompt = buildIntentPrompt({
    changeTitle: change.title,
    transcript: grade === "transcript" ? deps.capture.condense(capture) : null,
    diffText: deps.diffs.format(diff),
  });

  const result = await deps.models.generate({
    model: organisation.settings.models.intent,
    messages: [{ role: "user", content: prompt }],
    maxOutputTokens: 400,
    attribution: { agent: "intent", repositoryId: repository.id, changeId },
    output: { name: "intent", schema: intentOutput },
  });

  const createdAt = deps.clock.now();
  // Written in one batch with the change event, so a failure between the two
  // (a retry would otherwise see the intent but never emit its event) cannot
  // happen: either both commit or neither does. `appendChangeEvent` cannot be
  // reused here; it only ever runs its own two statements.
  const [, , eventRows] = await deps.db.batch([
    deps.db.insert(schema.intents).values({
      id: deps.ids.next("intent"),
      changeId,
      revisionId,
      version: (latest?.version ?? 0) + 1,
      statement: result.output.statement,
      grade,
      checkpointIds,
      model: result.model,
      createdAt,
    }),
    deps.db
      .update(schema.changes)
      .set({ lastEventSeq: sql`${schema.changes.lastEventSeq} + 1` })
      .where(eq(schema.changes.id, changeId)),
    deps.db
      .insert(schema.changeEvents)
      .values({
        changeId,
        seq: sql`(select ${schema.changes.lastEventSeq} from ${schema.changes} where ${schema.changes.id} = ${changeId})`,
        body: { type: "intent.updated" },
        at: createdAt,
      })
      .returning({ seq: schema.changeEvents.seq }),
  ]);
  const seq = eventRows[0]?.seq;
  if (seq !== undefined) {
    await deps.live
      .publish({ type: "intent.updated", changeId, seq, at: createdAt })
      .catch(() => {});
  }

  return { status: "succeeded" };
};

/** The change's current intent: the highest version. */
export async function currentIntent(
  deps: Pick<IntentDeps, "db">,
  changeId: Intent["changeId"],
): Promise<Intent | null> {
  const [row] = await deps.db
    .select()
    .from(schema.intents)
    .where(eq(schema.intents.changeId, changeId))
    .orderBy(desc(schema.intents.version))
    .limit(1);
  return row ?? null;
}
