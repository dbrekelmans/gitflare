import { sectionStats } from "@gitflare/core";
import type { Db } from "@gitflare/db";
import { fromModelCall, fromRevision, fromThreadMessage, schema } from "@gitflare/db";
import { type DemoData, demo } from "./demo";

/** D1 allows 100 bound parameters per statement; this keeps every insert under it. */
function chunks<T extends object>(rows: T[]): T[][] {
  const first = rows[0];
  if (!first) return [];
  const size = Math.max(1, Math.floor(90 / Object.keys(first).length));
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

/**
 * Writes the demo fixture into an empty database: every table, with the same
 * ids the fixture API serves. Local development runs it once; tests call it to
 * start from a populated database. It does nothing if an organisation exists.
 */
export async function seedDemo(db: Db, data: DemoData = demo): Promise<boolean> {
  const existing = await db
    .select({ id: schema.organisations.id })
    .from(schema.organisations)
    .limit(1);
  if (existing.length > 0) return false;

  const lastSeq = new Map<string, number>();
  for (const event of data.changeEvents) lastSeq.set(event.changeId, event.seq);
  const nextNumber = new Map<string, number>();
  for (const change of data.changes) {
    nextNumber.set(
      change.repositoryId,
      Math.max(nextNumber.get(change.repositoryId) ?? 1, change.number + 1),
    );
  }
  const stageRunFor = new Map(
    data.stageRuns.filter((run) => run.stage === "ci").map((run) => [run.revisionId, run.id]),
  );

  const insert = async <T extends object>(table: Parameters<Db["insert"]>[0], rows: T[]) => {
    for (const chunk of chunks(rows)) await db.insert(table).values(chunk as never);
  };

  await insert(schema.organisations, [data.organisation]);
  await insert(schema.users, data.users);
  await insert(
    schema.repositories,
    data.repositories.map((r) => ({ ...r, nextChangeNumber: nextNumber.get(r.id) ?? 1 })),
  );
  await insert(schema.sessions, data.sessions);
  await insert(schema.sessionLaunches, data.sessionLaunches);
  await insert(
    schema.cloudSessionEvents,
    data.cloudSessions.events.map(({ sessionId, seq, at, ...body }) => ({
      sessionId,
      seq,
      at,
      body: body as never,
    })),
  );
  await insert(
    schema.changes,
    data.changes.map((c) => ({ ...c, lastEventSeq: lastSeq.get(c.id) ?? 0 })),
  );
  await insert(schema.revisions, data.revisions.map(fromRevision));
  await insert(
    schema.changeCommits,
    data.commits.map((commit, position) => ({ ...commit, position })),
  );
  await insert(schema.stageRuns, data.stageRuns);
  await insert(
    schema.changeEvents,
    data.changeEvents.map(({ changeId, seq, at, ...body }) => ({
      changeId,
      seq,
      at,
      body: body as never,
    })),
  );
  await insert(schema.checkpoints, data.checkpoints);
  await insert(
    schema.capturedSessions,
    data.capturedSessions.map(({ turns, ...session }) => ({ ...session, turnCount: turns.length })),
  );
  await insert(schema.intents, data.intents);
  await insert(schema.revisionReviews, data.revisionReviews);
  await insert(
    schema.sections,
    data.sections.map((section) => ({
      ...section,
      stats: sectionStats(data.sectionDiffs[section.id] ?? [], section.files),
    })),
  );
  await insert(schema.approvals, data.approvals);
  await insert(schema.threads, data.threads);
  await insert(schema.threadMessages, data.messages.map(fromThreadMessage));
  await insert(
    schema.ciRuns,
    data.ciRuns.map((run) => ({
      ...run,
      stageRunId: stageRunFor.get(run.revisionId) ?? "stg_missing",
    })),
  );
  await insert(schema.ciSteps, data.ciSteps);
  await insert(schema.decisions, data.decisions);
  await insert(schema.decisionEvents, data.decisionEvents);
  await insert(schema.changeDecisions, data.changeDecisions);
  await insert(schema.modelCalls, data.modelCalls.map(fromModelCall));
  return true;
}
