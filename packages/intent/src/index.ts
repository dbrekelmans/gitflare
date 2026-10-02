import {
  forkRepoName,
  type Intent,
  type IntentGrade,
  type StageHandler,
  type StageInput,
} from "@gitflare/core";
import type {
  CapturePort,
  ChangeLive,
  Clock,
  DiffPort,
  IdGenerator,
  ModelGateway,
} from "@gitflare/core/ports";
import {
  changeEventStatements,
  type Db,
  publishChangeEvent,
  schema,
  storedChangeEvent,
} from "@gitflare/db";
import { and, desc, eq } from "drizzle-orm";
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
 *
 * One attempt writes at most one version (`intents_revision_attempt`). An
 * attempt that finds its version already written is a retried Workflow step:
 * it succeeds without asking the model again.
 */
export const runIntentStage: StageHandler<IntentDeps> = async (deps, input) => {
  const { changeId, revisionId, attempt } = input;

  const [change] = await deps.db
    .select()
    .from(schema.changes)
    .where(eq(schema.changes.id, changeId));
  if (!change) throw new Error(`intent stage: change ${changeId} does not exist`);

  if (await attemptWrote(deps.db, input)) return { status: "succeeded" };
  const latest = await currentIntent(deps, changeId);
  // A later revision's automatic first attempt, with the intent already
  // derived (on an earlier revision, necessarily): intent runs once.
  if (attempt === 1 && latest) return { status: "skipped", reason: SKIP_REASON };

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
  const body = { type: "intent.updated" } as const;
  try {
    // The event commits with the version, so a run that dies after the write cannot lose it.
    const [, , stored] = await deps.db.batch([
      deps.db.insert(schema.intents).values({
        id: deps.ids.next("intent"),
        changeId,
        revisionId,
        version: (latest?.version ?? 0) + 1,
        attempt,
        statement: result.output.statement,
        grade,
        checkpointIds,
        model: result.model,
        createdAt,
      }),
      ...changeEventStatements(deps.db, changeId, body, createdAt),
    ]);
    await publishChangeEvent(deps.live, storedChangeEvent(changeId, body, createdAt, stored));
  } catch (error) {
    // The same attempt, run twice at once, and the other run wrote first: the index refused this one.
    if (await attemptWrote(deps.db, input)) return { status: "succeeded" };
    throw error;
  }

  return { status: "succeeded" };
};

/** Whether this attempt has already written its version of the intent. */
async function attemptWrote(
  db: Db,
  { revisionId, attempt }: Pick<StageInput, "revisionId" | "attempt">,
): Promise<boolean> {
  const [row] = await db
    .select({ id: schema.intents.id })
    .from(schema.intents)
    .where(and(eq(schema.intents.revisionId, revisionId), eq(schema.intents.attempt, attempt)))
    .limit(1);
  return row !== undefined;
}

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
