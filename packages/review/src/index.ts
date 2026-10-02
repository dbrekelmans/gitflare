import {
  type DismissalClass,
  notImplemented,
  type StageHandler,
  type Thread,
  type ThreadId,
  type ThreadMessage,
  type User,
} from "@gitflare/core";
import type {
  ChangeLive,
  Clock,
  GitHost,
  GitWriter,
  IdGenerator,
  ModelGateway,
  NewThreadMessage,
  ThreadHost,
} from "@gitflare/core/ports";
import type { Db } from "@gitflare/db";

// @gitflare/review — the automatic review and the conversation that follows
// it. The review reads the change with the repository's relevant decisions and
// leaves findings as comment threads. When the author answers one, the agent
// replies, resolves it, dismisses it (saying which kind of dismissal it was),
// or pushes a fix to the session's fork. Build task: `review`.

export interface ReviewDeps {
  db: Db;
  git: GitHost;
  gitWriter: GitWriter;
  models: ModelGateway;
  threads: ThreadHost;
  live: ChangeLive;
  clock: Clock;
  ids: IdGenerator;
}

/**
 * The review stage. Opens one comment thread per finding, anchored to a file
 * and lines; a thread's section is filled in with `sectionForAnchor` once
 * sections exist. Running it again for the same revision does not duplicate
 * threads.
 */
export const runReviewStage: StageHandler<ReviewDeps> = async () =>
  notImplemented("@gitflare/review runReviewStage");

/**
 * Appends a message to a thread: assigns the next sequence number, writes the
 * `thread_messages` row, updates the thread's counters and emits
 * `thread.message`. The thread's Durable Object calls this, and only it does,
 * which is what keeps a thread's messages in one order.
 */
export async function appendMessage(
  _deps: Pick<ReviewDeps, "db" | "live" | "clock" | "ids">,
  _threadId: ThreadId,
  _message: NewThreadMessage,
): Promise<ThreadMessage> {
  return notImplemented("@gitflare/review appendMessage");
}

/**
 * The agent's turn on a thread, run after a person's message. Streams its
 * reply as `thread.delta` signals, then appends it with whatever action it
 * took. Does nothing on a thread the agent has no part in.
 */
export async function runAgentTurn(
  _deps: ReviewDeps,
  _threadId: ThreadId,
): Promise<ThreadMessage | null> {
  return notImplemented("@gitflare/review runAgentTurn");
}

export type SettleAction =
  | { type: "resolve" }
  | { type: "dismiss"; classification: DismissalClass; reason: string }
  | { type: "reclassify"; classification: DismissalClass }
  | { type: "reopen" };

/**
 * A person settling, reclassifying or reopening a comment. A dismissal
 * classified as a design decision records the decision; reclassifying away
 * from that leaves the decision in place for a person to remove.
 */
export async function settleThread(
  _deps: ReviewDeps,
  _user: User,
  _threadId: ThreadId,
  _action: SettleAction,
): Promise<Thread> {
  return notImplemented("@gitflare/review settleThread");
}
