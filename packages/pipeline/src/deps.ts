import {
  type ChangeEventBody,
  type ChangeId,
  ForgeError,
  latestStageRuns,
  type SessionId,
  type StageRun,
  stageNames,
} from "@gitflare/core";
import type {
  CapturePort,
  ChangeLive,
  Clock,
  CloudSessions,
  DecisionsPort,
  DiffPort,
  GitHost,
  GitWriter,
  IdGenerator,
  PipelineRunner,
} from "@gitflare/core/ports";
import { appendChangeEvent, type Db, schema } from "@gitflare/db";
import { eq } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";

export interface PipelineDeps {
  db: Db;
  git: GitHost;
  gitWriter: GitWriter;
  capture: CapturePort;
  diffs: DiffPort;
  decisions: DecisionsPort;
  live: ChangeLive;
  /** For a push the change has not taken in yet, raised again by a merge that finds it. */
  pipeline: PipelineRunner;
  /** For stopping a hosted session's sandbox when the session ends. */
  cloudSessions: CloudSessions;
  clock: Clock;
  ids: IdGenerator;
}

export type ChangeRow = typeof schema.changes.$inferSelect;
export type SessionRow = typeof schema.sessions.$inferSelect;

export function emit(
  deps: Pick<PipelineDeps, "db" | "live" | "clock">,
  changeId: ChangeId,
  body: ChangeEventBody,
) {
  return appendChangeEvent(deps, changeId, body);
}

/** `db.batch` for a list built at run time: D1's only way to commit statements together. */
export async function commit(db: Db, statements: BatchItem<"sqlite">[]): Promise<unknown[]> {
  const [first, ...rest] = statements;
  return first ? db.batch([first, ...rest]) : [];
}

/** D1 allows 100 bound parameters per statement; this keeps a multi-row insert under it. */
export function chunks<T extends object>(rows: T[]): T[][] {
  const first = rows[0];
  if (!first) return [];
  const size = Math.max(1, Math.floor(90 / Object.keys(first).length));
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

export async function requireChange(db: Db, changeId: ChangeId): Promise<ChangeRow> {
  const [row] = await db.select().from(schema.changes).where(eq(schema.changes.id, changeId));
  if (!row) throw new ForgeError("not_found", "Change not found.");
  return row;
}

export async function requireSession(db: Db, sessionId: SessionId): Promise<SessionRow> {
  const [row] = await db.select().from(schema.sessions).where(eq(schema.sessions.id, sessionId));
  if (!row) throw new ForgeError("not_found", "Session not found.");
  return row;
}

/** The newest attempt of each stage, in stage order. */
export function latestInStageOrder(runs: readonly StageRun[]): StageRun[] {
  const latest = latestStageRuns(runs);
  return stageNames.flatMap((stage) => latest[stage] ?? []);
}

/** The newest attempt of each stage for one revision. */
export async function headStageRuns(
  db: Db,
  revisionId: StageRun["revisionId"],
): Promise<StageRun[]> {
  const runs = await db
    .select()
    .from(schema.stageRuns)
    .where(eq(schema.stageRuns.revisionId, revisionId));
  return latestInStageOrder(runs);
}
