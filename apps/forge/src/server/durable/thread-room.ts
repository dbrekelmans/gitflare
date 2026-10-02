import { DurableObject } from "cloudflare:workers";
import type { ThreadId, ThreadMessage } from "@gitflare/core";
import type { NewThreadMessage } from "@gitflare/core/ports";
import { appendMessage, learnFromSettledThread, runAgentTurn } from "@gitflare/review";
import { getServices } from "../services";

/** The turn in flight: the thread, and the person's message it has still to answer. */
interface PendingTurn {
  threadId: ThreadId;
  seq: number;
}

const TURN = "turn";
/** The thread to consider for a decision once the alarm has run any turn. */
const LEARN = "learn";

/**
 * One per thread, named by thread id: the single writer of that thread's
 * conversation. Because every message goes through this object, messages get
 * their order here and one thread never runs two agent turns at once. Its own
 * storage holds the turn in flight (so an eviction mid-reply can be picked up
 * again); settled messages are written through to `thread_messages` with
 * `appendMessage` from `@gitflare/review`. Build task: `review`.
 *
 * The turn runs in the object's alarm: an alarm outlives the request that set
 * it and an eviction, is retried when it throws, and never runs twice at once.
 * After the turn the alarm learns from the thread if it is settled, whoever
 * settled it; a failure to learn is thrown, so the alarm retries it and the
 * runtime logs it.
 */
export class ThreadRoom extends DurableObject<Env> {
  /** Appends the message, then, for a person's message, starts the agent's turn without waiting for it. */
  async post(threadId: ThreadId, message: NewThreadMessage): Promise<ThreadMessage> {
    const stored = await appendMessage(getServices(), threadId, message);
    if (message.author.kind === "user") {
      await this.ctx.storage.put<PendingTurn>(TURN, { threadId, seq: stored.seq });
      await this.ctx.storage.setAlarm(Date.now());
    }
    return stored;
  }

  /** A person settled the thread: learn from it, off the request that settled it. */
  async settled(threadId: ThreadId): Promise<void> {
    await this.ctx.storage.put<ThreadId>(LEARN, threadId);
    await this.ctx.storage.setAlarm(Date.now());
  }

  async alarm(): Promise<void> {
    const services = getServices();
    const turn = await this.ctx.storage.get<PendingTurn>(TURN);
    if (turn) {
      // The turn may settle the thread; learning is owed then, even if the turn fails after.
      await this.ctx.storage.put<ThreadId>(LEARN, turn.threadId);
      await runAgentTurn(services, turn.threadId);
      // A person who wrote during the turn has set the alarm again; their message is the newer one.
      const latest = await this.ctx.storage.get<PendingTurn>(TURN);
      if (latest?.seq === turn.seq) await this.ctx.storage.delete(TURN);
    }
    const learn = await this.ctx.storage.get<ThreadId>(LEARN);
    if (!learn) return;
    await learnFromSettledThread(services, learn);
    await this.ctx.storage.delete(LEARN);
  }
}
