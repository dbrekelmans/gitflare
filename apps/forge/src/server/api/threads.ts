import { can, ForgeError, type ThreadId } from "@gitflare/core";
import type { ApiContext, ForgeApi } from "@gitflare/core/api";
import {
  listThreads,
  openThread,
  type SettleAction,
  settleThread,
  threadView,
} from "@gitflare/review";
import type { Services } from "../services";

/**
 * Review comments and chats on a change, and settling them.
 * Build task: `review`.
 */
export function threadsApi(services: Services): ForgeApi["threads"] {
  const allow = (ctx: ApiContext, type: "repository.read" | "change.review") => {
    if (!can(ctx.user, { type })) {
      throw new ForgeError("forbidden", "You may not do that on this change.");
    }
  };
  const settle = async (ctx: ApiContext, threadId: ThreadId, action: SettleAction) => {
    allow(ctx, "change.review");
    await settleThread(services, ctx.user, threadId, action);
    return threadView(services, threadId);
  };

  return {
    async list(ctx, input) {
      allow(ctx, "repository.read");
      return listThreads(services, input.changeId);
    },
    async open(ctx, input) {
      allow(ctx, "change.review");
      const thread = await openThread(services, ctx.user, input);
      return threadView(services, thread.id);
    },
    async post(ctx, input) {
      allow(ctx, "change.review");
      // Read first: a thread that does not exist is refused here, not inside its Durable Object.
      await threadView(services, input.threadId);
      await services.threads.post(input.threadId, {
        author: { kind: "user", userId: ctx.user.id },
        body: input.body,
      });
      return threadView(services, input.threadId);
    },
    resolve: (ctx, input) => settle(ctx, input.threadId, { type: "resolve" }),
    dismiss: (ctx, { threadId, ...dismissal }) =>
      settle(ctx, threadId, { type: "dismiss", ...dismissal }),
    reclassify: (ctx, { threadId, classification }) =>
      settle(ctx, threadId, { type: "reclassify", classification }),
    reopen: (ctx, input) => settle(ctx, input.threadId, { type: "reopen" }),
  };
}
