import {
  type ChangeId,
  ForgeError,
  sectionForAnchor,
  type Thread,
  type ThreadId,
  type User,
} from "@gitflare/core";
import type { OpenThreadInput, ThreadView } from "@gitflare/core/api";
import { appendChangeEvent, schema } from "@gitflare/db";
import type { z } from "zod";
import {
  authorsOf,
  changeThreads,
  currentSections,
  messagesOf,
  type ReviewDeps,
  requireChange,
  requireThread,
} from "./store";

async function views(deps: Pick<ReviewDeps, "db">, threads: Thread[]): Promise<ThreadView[]> {
  const messages = await messagesOf(
    deps.db,
    threads.map((thread) => thread.id),
  );
  const authors = await authorsOf(deps.db, messages);
  return threads.map((thread) => ({
    thread,
    messages: messages
      .filter((message) => message.threadId === thread.id)
      .map((message) => {
        const user = message.author.kind === "user" ? authors.get(message.author.userId) : null;
        return {
          ...message,
          user: user ? { id: user.id, name: user.name, email: user.email } : null,
        };
      }),
  }));
}

/** Every thread of the change with its messages, oldest thread first. */
export async function listThreads(
  deps: Pick<ReviewDeps, "db">,
  changeId: ChangeId,
): Promise<ThreadView[]> {
  await requireChange(deps.db, changeId);
  return views(deps, await changeThreads(deps.db, changeId));
}

export async function threadView(
  deps: Pick<ReviewDeps, "db">,
  threadId: ThreadId,
): Promise<ThreadView> {
  const [view] = await views(deps, [await requireThread(deps.db, threadId)]);
  if (!view) throw new ForgeError("not_found", `Thread ${threadId} does not exist.`);
  return view;
}

/**
 * A person opening a comment or a chat on a change. Their first message goes
 * through the thread's own writer like every later one, so on a chat the
 * agent answers it.
 */
export async function openThread(
  deps: Pick<ReviewDeps, "db" | "live" | "clock" | "ids" | "threads">,
  user: User,
  input: z.output<typeof OpenThreadInput>,
): Promise<Thread> {
  const change = await requireChange(deps.db, input.changeId);
  const sections = await currentSections(deps.db, change.id);
  if (input.sectionId && !sections.some((section) => section.id === input.sectionId)) {
    throw new ForgeError("invalid", `Section ${input.sectionId} is not part of this change.`);
  }
  const now = deps.clock.now();
  const thread: Thread = {
    id: deps.ids.next("thread"),
    changeId: change.id,
    sectionId: input.sectionId ?? (input.anchor ? sectionForAnchor(sections, input.anchor) : null),
    kind: input.kind,
    origin: "human",
    status: "open",
    finding: null,
    anchor: input.anchor ?? null,
    anchorRevisionId: input.anchor ? change.headRevisionId : null,
    dismissal: null,
    decisionId: null,
    createdBy: user.id,
    createdAt: now,
    settledAt: null,
    settledBy: null,
    messageCount: 0,
    lastMessageAt: now,
  };
  await deps.db.insert(schema.threads).values(thread);
  await appendChangeEvent(deps, change.id, { type: "thread.opened", threadId: thread.id });
  await deps.threads.post(thread.id, {
    author: { kind: "user", userId: user.id },
    body: input.body,
  });
  return thread;
}
