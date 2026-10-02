import type { CloudSessionEvent, CloudSessionEventBody, SessionId } from "@gitflare/core";
import { type Db, schema, toCloudSessionEvent } from "@gitflare/db";
import { and, asc, desc, eq, gt, inArray, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import type { SessionEventDraft } from "./events";

// A hosted session's event log, in `cloud_session_events`. Every event has a
// place in it that never changes: an event a sandbox reports is stored at a
// number derived from the prompt that started its turn, so reading the same
// sandbox twice, or from two requests at once, stores it once.

const { cloudSessionEvents: events } = schema;

/** D1 allows 100 bound parameters per statement; an event binds four. */
const EVENTS_PER_INSERT = 25;

type Batch = [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]];
type EventRow = typeof events.$inferSelect;

function toRow(sessionId: SessionId, seq: number | ReturnType<typeof sql<number>>) {
  return (draft: SessionEventDraft) => {
    const { at, ...body } = draft;
    return { sessionId, seq, at, body: body as CloudSessionEventBody };
  };
}

/** Records events after everything the session has recorded, in order, and returns them. */
export async function appendEvents(
  db: Db,
  sessionId: SessionId,
  drafts: [SessionEventDraft, ...SessionEventDraft[]],
): Promise<CloudSessionEvent[]> {
  // Each statement takes the number after the last, so a batch's events are consecutive.
  const next = sql<number>`(select coalesce(max(${events.seq}), 0) + 1 from ${events} where ${events.sessionId} = ${sessionId})`;
  const statements = drafts.map((draft) =>
    db.insert(events).values(toRow(sessionId, next)(draft)).returning(),
  );
  const stored = (await db.batch(statements as unknown as Batch)) as EventRow[][];
  return stored.flat().map(toCloudSessionEvent);
}

/**
 * Stores events at `seq` and the numbers after it. A number already taken
 * keeps what it has: the same turn read again yields the same events.
 */
export async function storeEvents(
  db: Db,
  sessionId: SessionId,
  seq: number,
  drafts: SessionEventDraft[],
): Promise<void> {
  const rows = drafts.map((draft, index) => toRow(sessionId, seq + index)(draft));
  const statements: BatchItem<"sqlite">[] = [];
  for (let from = 0; from < rows.length; from += EVENTS_PER_INSERT) {
    statements.push(
      db
        .insert(events)
        .values(rows.slice(from, from + EVENTS_PER_INSERT))
        .onConflictDoNothing(),
    );
  }
  if (statements.length > 0) await db.batch(statements as Batch);
}

export async function eventsAfter(
  db: Db,
  sessionId: SessionId,
  after: number,
): Promise<CloudSessionEvent[]> {
  const rows = await db
    .select()
    .from(events)
    .where(and(eq(events.sessionId, sessionId), gt(events.seq, after)))
    .orderBy(asc(events.seq));
  return rows.map(toCloudSessionEvent);
}

export async function lastEvent(db: Db, sessionId: SessionId): Promise<CloudSessionEvent | null> {
  const [row] = await db
    .select()
    .from(events)
    .where(eq(events.sessionId, sessionId))
    .orderBy(desc(events.seq))
    .limit(1);
  return row ? toCloudSessionEvent(row) : null;
}

function ofType(...types: CloudSessionEventBody["type"][]) {
  return inArray(sql<string>`json_extract(${events.body}, '$.type')`, types);
}

export type PromptEvent = Extract<CloudSessionEvent, { type: "prompt" }>;

/** The session's first prompt, or the latest one after `since`. */
export async function findPrompt(
  db: Db,
  sessionId: SessionId,
  which: { first: true } | { latestAfter: number },
): Promise<PromptEvent | null> {
  const after = "first" in which ? 0 : which.latestAfter;
  const [row] = await db
    .select()
    .from(events)
    .where(and(eq(events.sessionId, sessionId), gt(events.seq, after), ofType("prompt")))
    .orderBy("first" in which ? asc(events.seq) : desc(events.seq))
    .limit(1);
  return row ? (toCloudSessionEvent(row) as PromptEvent) : null;
}

/** Whether the agent has said or done anything since `since`: it then has a conversation to continue. */
export async function agentActedAfter(db: Db, sessionId: SessionId, since: number) {
  const [row] = await db
    .select({ seq: events.seq })
    .from(events)
    .where(and(eq(events.sessionId, sessionId), gt(events.seq, since), ofType("assistant", "tool")))
    .limit(1);
  return row !== undefined;
}
