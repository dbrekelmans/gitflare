/// <reference types="@cloudflare/vitest-plugin/types" />
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { ThreadId } from "@gitflare/core";
import { schema } from "@gitflare/db";
import { createD1Db } from "@gitflare/db/d1";
import { createDemoPorts } from "@gitflare/testing";
import { demoChanges, demoUsers } from "@gitflare/testing/demo";
import { asc, eq } from "drizzle-orm";
import { expect, it } from "vitest";
import { createThreadHost } from "../adapters/runtime";
import { threadsApi } from "../api/threads";
import { ensureDevDatabase } from "../dev";
import type { Services } from "../services";
import type { ThreadRoom } from "./thread-room";

// The real ThreadRoom in workerd against local D1: the order of a thread's
// messages has to hold on D1 itself, with posts arriving at once.

const { maya, jonas, priya } = demoUsers;

let shared: Services | undefined;

async function services(): Promise<Services> {
  shared ??= {
    ...createDemoPorts(),
    db: createD1Db(env.DB),
    threads: createThreadHost(env),
    mode: "dev",
  };
  await ensureDevDatabase(shared, env.DB);
  return shared;
}

const stored = (db: Services["db"], threadId: ThreadId) =>
  db
    .select()
    .from(schema.threadMessages)
    .where(eq(schema.threadMessages.threadId, threadId))
    .orderBy(asc(schema.threadMessages.seq));

it("gives the messages of one thread consecutive seq under concurrent posts", async () => {
  const deps = await services();
  const api = threadsApi(deps);
  // A comment between people: the agent has no part in it, so only what is posted is written.
  const { thread } = await api.open(
    { user: priya },
    { changeId: demoChanges.review.id, kind: "comment", body: "Should this be behind the flag?" },
  );
  const people = [maya, jonas, priya];
  const bodies = Array.from({ length: 12 }, (_, index) => `reply ${index}`);

  const views = await Promise.all(
    bodies.map((body, index) =>
      api.post({ user: people[index % 3] ?? maya }, { threadId: thread.id, body }),
    ),
  );

  const rows = await stored(deps.db, thread.id);
  expect(rows.map((row) => row.seq)).toEqual(Array.from({ length: 13 }, (_, index) => index + 1));
  expect(rows.map((row) => row.body).sort()).toEqual(
    ["Should this be behind the flag?", ...bodies].sort(),
  );
  const [row] = await deps.db.select().from(schema.threads).where(eq(schema.threads.id, thread.id));
  expect(row).toMatchObject({ messageCount: 13 });
  // Every caller got a view that includes their own message.
  views.forEach((view, index) => {
    expect(view.messages.map((message) => message.body)).toContain(bodies[index]);
  });
});

async function waitUntil(predicate: () => Promise<boolean>, ms = 3000): Promise<void> {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > ms) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

it("keeps the turn in flight in its own storage, and forgets it once the alarm has run it", async () => {
  const deps = await services();
  const threadId: ThreadId = "thr_worker_turn";
  const at = deps.clock.now();
  await deps.db.insert(schema.threads).values({
    id: threadId,
    changeId: demoChanges.review.id,
    kind: "comment",
    // Between people: the agent's turn runs and has nothing to write.
    origin: "human",
    status: "open",
    createdBy: priya.id,
    createdAt: at,
    lastMessageAt: at,
  });
  const room = env.THREAD_ROOM.getByName(threadId);
  const inFlight = () =>
    runInDurableObject(room, async (_instance: ThreadRoom, state) => ({
      turn: await state.storage.get("turn"),
      alarm: await state.storage.getAlarm(),
    }));

  // The agent's own message asks for no turn.
  await room.post(threadId, { author: { kind: "agent" }, body: "Noted." });
  expect(await inFlight()).toEqual({ turn: undefined, alarm: null });

  // A person's does. Read in the same event as the post, before the alarm can fire.
  const posted = await runInDurableObject(room, async (instance: ThreadRoom, state) => {
    const message = await instance.post(threadId, {
      author: { kind: "user", userId: priya.id },
      body: "Who owns this route?",
    });
    return {
      message,
      turn: await state.storage.get("turn"),
      alarm: await state.storage.getAlarm(),
    };
  });
  expect(posted.message).toMatchObject({ seq: 2, author: { kind: "user", userId: priya.id } });
  expect(posted.turn).toEqual({ threadId, seq: 2 });
  expect(posted.alarm).not.toBeNull();

  await waitUntil(async () => (await inFlight()).turn === undefined);
  expect((await stored(deps.db, threadId)).map((row) => row.authorKind)).toEqual(["agent", "user"]);
});

async function learnedAt(db: Services["db"], threadId: ThreadId): Promise<number | null> {
  const [row] = await db
    .select({ learnedAt: schema.threads.learnedAt })
    .from(schema.threads)
    .where(eq(schema.threads.id, threadId));
  return row?.learnedAt ?? null;
}

async function settledComment(deps: Services, threadId: ThreadId): Promise<void> {
  const at = deps.clock.now();
  await deps.db.insert(schema.threads).values({
    id: threadId,
    changeId: demoChanges.review.id,
    kind: "comment",
    origin: "review",
    status: "resolved",
    createdAt: at,
    settledAt: at,
    settledBy: jonas.id,
    lastMessageAt: at,
  });
}

it("learns from a thread a person settled, off the request that settled it", async () => {
  const deps = await services();
  const threadId: ThreadId = "thr_worker_settled";
  await settledComment(deps, threadId);
  const room = env.THREAD_ROOM.getByName(threadId);

  await room.settled(threadId);

  await waitUntil(async () => (await learnedAt(deps.db, threadId)) !== null);
  const pending = await runInDurableObject(room, async (_instance: ThreadRoom, state) =>
    state.storage.get("learn"),
  );
  expect(pending).toBeUndefined();
});

it("learns from a thread after the turn a person's reason asked for", async () => {
  const deps = await services();
  const threadId: ThreadId = "thr_worker_reason";
  await settledComment(deps, threadId);
  const room = env.THREAD_ROOM.getByName(threadId);

  // A dismissal's reason arrives on a settled thread: the turn has nothing to answer, learning runs.
  await room.post(threadId, {
    author: { kind: "user", userId: jonas.id },
    body: "We never retry inside a request handler.",
  });

  await waitUntil(async () => (await learnedAt(deps.db, threadId)) !== null);
  expect((await stored(deps.db, threadId)).map((row) => row.authorKind)).toEqual(["user"]);
});
