import type { ChangeEvent, ChangeEventBody, ChangeId } from "@gitflare/core";
import type { ChangeLive, Clock } from "@gitflare/core/ports";
import { and, asc, eq, gt, sql } from "drizzle-orm";
import type { Db } from "./index";
import { changeEvents, changes } from "./schema";

/**
 * Records one event on a change and tells the browsers watching it. This is
 * the only way an event is created, so that sequence numbers stay gap-free:
 * the number is taken and stored by one statement each, committed together.
 *
 * The broadcast is best-effort. A client that misses it catches up from the
 * log with `changeEventsAfter` when it reconnects.
 */
export async function appendChangeEvent(
  deps: { db: Db; live: ChangeLive; clock: Clock },
  changeId: ChangeId,
  body: ChangeEventBody,
): Promise<ChangeEvent> {
  const at = deps.clock.now();
  const [, inserted] = await deps.db.batch([
    deps.db
      .update(changes)
      .set({ lastEventSeq: sql`${changes.lastEventSeq} + 1` })
      .where(eq(changes.id, changeId)),
    deps.db
      .insert(changeEvents)
      .values({
        changeId,
        seq: sql`(select ${changes.lastEventSeq} from ${changes} where ${changes.id} = ${changeId})`,
        body,
        at,
      })
      .returning({ seq: changeEvents.seq }),
  ]);
  const seq = inserted[0]?.seq;
  if (seq === undefined) throw new Error(`change ${changeId} does not exist`);
  const event = { ...body, changeId, seq, at } as ChangeEvent;
  await deps.live.publish(event).catch(() => {});
  return event;
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
