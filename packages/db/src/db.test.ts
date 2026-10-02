import type { ChangeEvent } from "@gitflare/core";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { appendChangeEvent, changeEventsAfter } from "./events";
import { migrations } from "./migrations";
import { changes, organisations } from "./schema";
import { createTestDb } from "./testing";

async function withChange() {
  const db = createTestDb();
  await db.insert(changes).values({
    id: "chg_1",
    repositoryId: "rep_1",
    sessionId: "ses_1",
    number: 1,
    title: "A change",
    status: "open",
    authorId: "usr_1",
    headRef: "refs/heads/work",
    baseSha: "a".repeat(40),
    headSha: "b".repeat(40),
    headRevisionId: "rev_1",
    openedAt: 1,
  });
  const published: ChangeEvent[] = [];
  const deps = {
    db,
    clock: { now: () => 1000 },
    live: {
      publish: async (event: ChangeEvent) => void published.push(event),
      signal: async () => {},
    },
  };
  return { db, deps, published };
}

describe("test database", () => {
  it("applies the migrations and round-trips JSON columns", async () => {
    expect(migrations.length).toBeGreaterThan(0);
    const db = createTestDb();
    const settings = {
      monthlyBudgetMicroUsd: 1,
      perChangeBudgetMicroUsd: 1,
      models: {
        intent: "m",
        sections: "m",
        review: "m",
        thread: "m",
        decisions: "m",
        session: "m",
        embedding: "e",
        fallbacks: ["f"],
      },
      workspace: { image: "base", snapshot: null },
    };
    await db
      .insert(organisations)
      .values({ id: "org_1", name: "Acme", slug: "acme", settings, createdAt: 1 });
    const [row] = await db.select().from(organisations).where(eq(organisations.id, "org_1"));
    expect(row?.settings).toEqual(settings);
  });

  it("commits a batch together or not at all", async () => {
    const db = createTestDb();
    const org = { name: "Acme", slug: "acme", settings: {} as never, createdAt: 1 };
    await expect(
      db.batch([
        db.insert(organisations).values({ ...org, id: "org_1" }),
        db.insert(organisations).values({ ...org, id: "org_2" }),
      ]),
    ).rejects.toThrow();
    expect(await db.select().from(organisations)).toEqual([]);
  });
});

describe("change events", () => {
  it("numbers events from 1 without gaps and publishes each", async () => {
    const { db, deps, published } = await withChange();
    const first = await appendChangeEvent(deps, "chg_1", {
      type: "change.status",
      status: "processing",
    });
    const second = await appendChangeEvent(deps, "chg_1", { type: "intent.updated" });
    expect([first.seq, second.seq]).toEqual([1, 2]);
    expect(published).toEqual([first, second]);
    expect(first).toEqual({
      type: "change.status",
      status: "processing",
      changeId: "chg_1",
      seq: 1,
      at: 1000,
    });
    const [change] = await db.select().from(changes);
    expect(change?.lastEventSeq).toBe(2);
  });

  it("replays what a reconnecting client missed", async () => {
    const { db, deps } = await withChange();
    await appendChangeEvent(deps, "chg_1", { type: "intent.updated" });
    await appendChangeEvent(deps, "chg_1", { type: "sections.updated" });
    await appendChangeEvent(deps, "chg_1", { type: "change.status", status: "ready" });
    const missed = await changeEventsAfter(db, "chg_1", 1);
    expect(missed.map((event) => [event.seq, event.type])).toEqual([
      [2, "sections.updated"],
      [3, "change.status"],
    ]);
  });

  it("still records the event when the broadcast fails", async () => {
    const { db, deps } = await withChange();
    deps.live.publish = async () => {
      throw new Error("no listeners");
    };
    await appendChangeEvent(deps, "chg_1", { type: "intent.updated" });
    expect(await changeEventsAfter(db, "chg_1", 0)).toHaveLength(1);
  });

  it("refuses an event for a change that does not exist", async () => {
    const { deps } = await withChange();
    await expect(
      appendChangeEvent(deps, "chg_missing", { type: "intent.updated" }),
    ).rejects.toThrow();
  });
});
