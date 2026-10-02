import type { ChangeEvent, ChangeEventBody, ChangeId, Timestamp } from "@gitflare/core";
import type { ChangeLive, Clock } from "@gitflare/core/ports";
import { and, asc, eq, gt, sql } from "drizzle-orm";
import type { Db } from "./index";
import { changeEvents, changes } from "./schema";

/**
 * The two statements that record one event: the first takes the change's next
 * sequence number, the second stores the event under it and returns the
 * number. These are the only statements that may write to `change_events`,
 * which is what keeps sequence numbers gap-free.
 *
 * For a caller whose own writes must commit with the event: spread them into
 * its `db.batch`, in this order and next to each other, then hand the second
 * statement's rows to `storedChangeEvent` and the result to
 * `publishChangeEvent`. Everything else uses `appendChangeEvent`.
 */
export function changeEventStatements(
  db: Db,
  changeId: ChangeId,
  body: ChangeEventBody,
  at: Timestamp,
) {
  return [
    db
      .update(changes)
      .set({ lastEventSeq: sql`${changes.lastEventSeq} + 1` })
      .where(eq(changes.id, changeId)),
    db
      .insert(changeEvents)
      .values({
        changeId,
        seq: sql`(select ${changes.lastEventSeq} from ${changes} where ${changes.id} = ${changeId})`,
        body,
        at,
      })
      .returning({ seq: changeEvents.seq }),
  ] as const;
}

/** The event a batch stored, from the rows `changeEventStatements`' second statement returned. */
export function storedChangeEvent(
  changeId: ChangeId,
  body: ChangeEventBody,
  at: Timestamp,
  rows: readonly { seq: number }[],
): ChangeEvent {
  const seq = rows[0]?.seq;
  if (seq === undefined) throw new Error(`change ${changeId} does not exist`);
  // The envelope is spread last: a body can never replace the event's own `seq`.
  return { ...body, changeId, seq, at } as ChangeEvent;
}

/**
 * Tells the browsers watching a change about a stored event. Best-effort: a
 * client that misses it catches up from the log with `changeEventsAfter`
 * when it reconnects.
 */
export async function publishChangeEvent(live: ChangeLive, event: ChangeEvent): Promise<void> {
  await live.publish(event).catch(() => {});
}

/** Records one event on a change and tells the browsers watching it. */
export async function appendChangeEvent(
  deps: { db: Db; live: ChangeLive; clock: Clock },
  changeId: ChangeId,
  body: ChangeEventBody,
): Promise<ChangeEvent> {
  const at = deps.clock.now();
  const [, inserted] = await deps.db.batch(changeEventStatements(deps.db, changeId, body, at));
  const event = storedChangeEvent(changeId, body, at, inserted);
  await publishChangeEvent(deps.live, event);
  return event;
}

/** The change's current sequence number, or null when there is no such change. */
export async function changeLastEventSeq(db: Db, changeId: ChangeId): Promise<number | null> {
  const [row] = await db
    .select({ lastEventSeq: changes.lastEventSeq })
    .from(changes)
    .where(eq(changes.id, changeId))
    .limit(1);
  return row?.lastEventSeq ?? null;
}

/** The change's events after a sequence number, oldest first. */
export async function changeEventsAfter(
  db: Db,
  changeId: ChangeId,
  after: number,
  limit = 500,
): Promise<ChangeEvent[]> {
  const rows = await db
    .select()
    .from(changeEvents)
    .where(and(eq(changeEvents.changeId, changeId), gt(changeEvents.seq, after)))
    .orderBy(asc(changeEvents.seq))
    .limit(limit);
  return rows.map((row) => ({ ...row.body, changeId, seq: row.seq, at: row.at }) as ChangeEvent);
}
