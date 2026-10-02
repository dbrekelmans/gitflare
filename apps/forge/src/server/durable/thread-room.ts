import { DurableObject } from "cloudflare:workers";
import type { ThreadId, ThreadMessage } from "@gitflare/core";
import { notImplemented } from "@gitflare/core";
import type { NewThreadMessage } from "@gitflare/core/ports";

/**
 * One per thread, named by thread id: the single writer of that thread's
 * conversation. Because every message goes through this object, messages get
 * their order here and one thread never runs two agent turns at once. Its own
 * storage holds the turn in flight (so an eviction mid-reply can be picked up
 * again); settled messages are written through to `thread_messages` with
 * `appendMessage` from `@gitflare/review`. Build task: `review`.
 */
export class ThreadRoom extends DurableObject<Env> {
  /** Appends the message, then, for a person's message, starts the agent's turn without waiting for it. */
  async post(_threadId: ThreadId, _message: NewThreadMessage): Promise<ThreadMessage> {
    return notImplemented("ThreadRoom.post");
  }
}
