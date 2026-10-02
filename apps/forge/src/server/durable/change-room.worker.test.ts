import { env } from "cloudflare:workers";
import type { ChangeId } from "@gitflare/core";
import type { LiveServerMessage } from "@gitflare/core/api";
import { httpRoutes } from "@gitflare/core/api";
import { appendChangeEvent } from "@gitflare/db";
import { createD1Db } from "@gitflare/db/d1";
import { createFakePorts } from "@gitflare/testing";
import { demoChanges } from "@gitflare/testing/demo";
import { expect, it } from "vitest";
import { createChangeLive } from "../adapters/runtime";
import { ensureDevDatabase } from "../dev";

// Runs in workerd against local D1 and the real ChangeRoom.

function services() {
  return { ...createFakePorts(), db: createD1Db(env.DB), mode: "dev" as const };
}

/**
 * Opens a client connection and appends every message it receives to `log`.
 * A persistent listener, polled from outside, rather than a one-shot promise
 * per message: with two sockets open on one object at once, the Workers test
 * runtime only makes progress once no more than one `message` await is
 * pending at a time.
 */
async function openSocket(changeId: ChangeId, log: LiveServerMessage[]): Promise<WebSocket> {
  const response = await env.CHANGE_ROOM.getByName(changeId).fetch(
    `https://forge${httpRoutes.changeLive(changeId)}`,
    { headers: { upgrade: "websocket" } },
  );
  const ws = response.webSocket;
  if (!ws) throw new Error("expected a WebSocket upgrade");
  ws.addEventListener("message", (event) => {
    log.push(JSON.parse((event as MessageEvent).data as string) as LiveServerMessage);
  });
  ws.accept();
  return ws;
}

async function waitUntil(predicate: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > ms) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

it("connects two clients, publishes, and both receive it", async () => {
  const deps = services();
  await ensureDevDatabase(deps, env.DB);
  const changeId = demoChanges.review.id;

  const logA: LiveServerMessage[] = [];
  const logB: LiveServerMessage[] = [];
  const a = await openSocket(changeId, logA);
  const b = await openSocket(changeId, logB);
  void a;
  void b;

  await waitUntil(() => logA.length >= 1 && logB.length >= 1);
  expect(logA[0]).toMatchObject({ type: "hello", changeId });
  expect(logB[0]).toMatchObject({ type: "hello", changeId });

  const event = await appendChangeEvent(
    { db: deps.db, live: createChangeLive(env), clock: deps.clock },
    changeId,
    { type: "intent.updated" },
  );

  await waitUntil(() => logA.length >= 2 && logB.length >= 2);
  expect(logA[1]).toEqual({ type: "event", event });
  expect(logB[1]).toEqual({ type: "event", event });
});

it("replays the gap to a client resuming from a sequence number", async () => {
  const deps = services();
  await ensureDevDatabase(deps, env.DB);
  const changeId = demoChanges.review.id;
  const live = createChangeLive(env);

  const first = await appendChangeEvent({ db: deps.db, live, clock: deps.clock }, changeId, {
    type: "intent.updated",
  });
  const second = await appendChangeEvent({ db: deps.db, live, clock: deps.clock }, changeId, {
    type: "sections.updated",
  });

  const log: LiveServerMessage[] = [];
  const ws = await openSocket(changeId, log);
  await waitUntil(() => log.length >= 1);
  expect(log[0]).toMatchObject({ type: "hello", lastSeq: second.seq });

  ws.send(JSON.stringify({ type: "resume", after: first.seq }));
  await waitUntil(() => log.length >= 2);
  expect(log[1]).toEqual({ type: "event", event: second });
});
