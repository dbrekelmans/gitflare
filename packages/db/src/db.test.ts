import { DatabaseSync } from "node:sqlite";
import type { ChangeEvent } from "@gitflare/core";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  appendChangeEvent,
  changeEventStatements,
  changeEventsAfter,
  publishChangeEvent,
  storedChangeEvent,
} from "./events";
import { migrations } from "./migrations";
import { changes, intents, organisations } from "./schema";
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

describe("the second migration", () => {
  function migratedFromFirst(seed: (sqlite: DatabaseSync) => void): DatabaseSync {
    const sqlite = new DatabaseSync(":memory:");
    const [first, ...rest] = migrations;
    for (const statement of first?.statements ?? []) sqlite.exec(statement);
    seed(sqlite);
    for (const migration of rest) {
      for (const statement of migration.statements) sqlite.exec(statement);
    }
    return sqlite;
  }

  it("comes after the first, which is unchanged", () => {
    expect(migrations.map((migration) => migration.name)).toEqual([
      "0000_initial.sql",
      "0001_contracts_round_two.sql",
    ]);
  });

  it("gives existing intents an attempt that is unique per revision", () => {
    const sqlite = migratedFromFirst((db) => {
      const insert = db.prepare(
        "insert into intents (id, change_id, revision_id, version, statement, grade, checkpoint_ids, created_at) values (?, 'chg_1', 'rev_1', ?, 's', 'diff', '[]', 1)",
      );
      insert.run("int_1", 1);
      insert.run("int_2", 2);
    });
    const rows = sqlite.prepare("select id, attempt from intents order by id").all();
    expect(rows.map((row) => ({ ...row }))).toEqual([
      { id: "int_1", attempt: 1 },
      { id: "int_2", attempt: 2 },
    ]);
  });

  it("carries a recorded rewording over as a whole wording", () => {
    const sqlite = migratedFromFirst((db) => {
      db.exec(
        "insert into decisions (id, repository_id, path, title, statement, rationale, scope, status, strength, origin, created_at, updated_at) values ('dec_1', 'rep_1', 'decisions/a.md', 'Title', 'New.', 'Because.', '{}', 'active', 0.5, 'manual', 1, 1)",
      );
      const insert = db.prepare(
        "insert into decision_events (id, decision_id, kind, strength_before, strength_after, statement_before, statement_after, created_at) values (?, 'dec_1', ?, 0.5, 0.5, ?, ?, 1)",
      );
      insert.run("dev_1", "created", null, null);
      insert.run("dev_2", "reshaped", "Old.", "New.");
      insert.run("dev_3", "reshaped", "New.", "New.");
    });
    const rows = sqlite.prepare("select id, wording from decision_events order by id").all();
    expect(rows.map((row) => [row.id, row.wording && JSON.parse(String(row.wording))])).toEqual([
      ["dev_1", null],
      [
        "dev_2",
        {
          before: { title: "Title", statement: "Old.", rationale: "Because." },
          after: { title: "Title", statement: "New.", rationale: "Because." },
        },
      ],
      // An edit that left the statement alone changed nothing that was recorded.
      ["dev_3", null],
    ]);
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

  it("commits an event with a caller's own writes, or neither", async () => {
    const { db, deps, published } = await withChange();
    await appendChangeEvent(deps, "chg_1", { type: "sections.updated" });
    const intent: typeof intents.$inferInsert = {
      id: "int_1",
      changeId: "chg_1",
      revisionId: "rev_1",
      version: 1,
      attempt: 1,
      statement: "Why",
      grade: "diff",
      checkpointIds: [],
      createdAt: 1000,
    };
    const body = { type: "intent.updated" } as const;

    const [, , rows] = await db.batch([
      db.insert(intents).values(intent),
      ...changeEventStatements(db, "chg_1", body, 2000),
    ]);
    const event = storedChangeEvent("chg_1", body, 2000, rows);
    await publishChangeEvent(deps.live, event);
    expect(event).toEqual({ type: "intent.updated", changeId: "chg_1", seq: 2, at: 2000 });
    expect(published.at(-1)).toEqual(event);
    expect(await changeEventsAfter(db, "chg_1", 1)).toEqual([event]);

    // The same attempt again: the intent is refused, and no event is left behind.
    await expect(
      db.batch([
        ...changeEventStatements(db, "chg_1", body, 3000),
        db.insert(intents).values({ ...intent, id: "int_2", version: 2 }),
      ]),
    ).rejects.toThrow();
    expect(await changeEventsAfter(db, "chg_1", 0)).toHaveLength(2);
    const [change] = await db.select().from(changes);
    expect(change?.lastEventSeq).toBe(2);
  });

  it("keeps a thread message's own sequence number apart from the event's", async () => {
    const { deps } = await withChange();
    await appendChangeEvent(deps, "chg_1", { type: "intent.updated" });
    const event = await appendChangeEvent(deps, "chg_1", {
      type: "thread.message",
      threadId: "thr_1",
      messageSeq: 7,
    });
    expect(event).toMatchObject({ seq: 2, messageSeq: 7 });
  });

  it("refuses an event for a change that does not exist", async () => {
    const { deps } = await withChange();
    await expect(
      appendChangeEvent(deps, "chg_missing", { type: "intent.updated" }),
    ).rejects.toThrow();
  });
});
