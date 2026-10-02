import type { ThreadId, ThreadMessage } from "@gitflare/core";
import type { NewThreadMessage } from "@gitflare/core/ports";
import { appendChangeEvent, fromThreadMessage, schema } from "@gitflare/db";
import { eq, sql } from "drizzle-orm";
import { type ReviewDeps, requireThread } from "./store";

/**
 * Appends a message to a thread: assigns the next sequence number, writes the
 * `thread_messages` row, updates the thread's counters and emits
 * `thread.message`. The thread's Durable Object calls this, and only it does,
 * which is what keeps a thread's messages in one order.
 *
 * The number is taken and stored by one statement each, committed together,
 * so two appends that do overlap still get consecutive numbers.
 */
export async function appendMessage(
  deps: Pick<ReviewDeps, "db" | "live" | "clock" | "ids">,
  threadId: ThreadId,
  message: NewThreadMessage,
): Promise<ThreadMessage> {
  const thread = await requireThread(deps.db, threadId);
  const stored: ThreadMessage = {
    id: deps.ids.next("message"),
    threadId,
    seq: 0,
    author: message.author,
    body: message.body,
    action: message.action ?? null,
    createdAt: deps.clock.now(),
  };
  const [, inserted] = await deps.db.batch([
    deps.db
      .update(schema.threads)
      .set({
        messageCount: sql`${schema.threads.messageCount} + 1`,
        lastMessageAt: stored.createdAt,
      })
      .where(eq(schema.threads.id, threadId)),
    deps.db
      .insert(schema.threadMessages)
      .values({
        ...fromThreadMessage(stored),
        seq: sql`(select ${schema.threads.messageCount} from ${schema.threads} where ${schema.threads.id} = ${threadId})`,
      })
      .returning({ seq: schema.threadMessages.seq }),
  ]);
  const seq = inserted[0]?.seq;
  if (seq === undefined) throw new Error(`thread ${threadId} took no message`);
  stored.seq = seq;
  await appendChangeEvent(deps, thread.changeId, { type: "thread.message", threadId, seq });
  return stored;
}
