import { forkRepoName, type Intent, type IntentGrade, type StageHandler } from "@gitflare/core";
import type {
  CapturePort,
  ChangeLive,
  Clock,
  DiffPort,
  IdGenerator,
  ModelGateway,
} from "@gitflare/core/ports";
import { appendChangeEvent, type Db, schema } from "@gitflare/db";
import { desc, eq } from "drizzle-orm";
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
 */
export const runIntentStage: StageHandler<IntentDeps> = async (deps, input) => {
  const { changeId, revisionId } = input;

  const [change] = await deps.db
    .select()
    .from(schema.changes)
    .where(eq(schema.changes.id, changeId));
  if (!change) throw new Error(`intent stage: change ${changeId} does not exist`);

  const latest = await currentIntent(deps, changeId);
  // A rerun targets the change's head revision: the same revision a prior
  // intent was derived for. A later revision's first attempt is skipped.
  if (latest && latest.revisionId !== revisionId) {
    return { status: "skipped", reason: SKIP_REASON };
  }

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

  await deps.db.insert(schema.intents).values({
    id: deps.ids.next("intent"),
    changeId,
    revisionId,
    version: (latest?.version ?? 0) + 1,
    statement: result.output.statement,
    grade,
    checkpointIds,
    model: result.model,
    createdAt: deps.clock.now(),
  });

  await appendChangeEvent(deps, changeId, { type: "intent.updated" });

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
