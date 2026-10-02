import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { StageInput, Thread, ThreadId, User } from "@gitflare/core";
import type { ThreadHost } from "@gitflare/core/ports";
import { type Db, fromThreadMessage, schema } from "@gitflare/db";
import { migrations } from "@gitflare/db/migrations";
import { createTestDb } from "@gitflare/db/testing";
import { createFakePorts, ManualClock } from "@gitflare/testing";
import { buildDemoGit, demo, demoChanges } from "@gitflare/testing/demo";
import { seedDemo } from "@gitflare/testing/seed";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import { appendMessage } from "../messages";
import type { ReviewDeps } from "../store";

// What the tests in this package start from: the demo deployment in a seeded
// database, its repositories in the fake git host, its captured session and
// its decisions behind the fake ports. Not part of the package.

export const atlas =
  demo.repositories[0] ??
  (() => {
    throw new Error("the demo has no repository");
  })();

/** Change #13: one commit, one file, pushed and not yet reviewed. */
export const unreviewed: StageInput = {
  changeId: demoChanges.cloud.id,
  revisionId: demoChanges.cloud.headRevisionId,
  stageRunId: "stg_demo13a_review",
  attempt: 1,
};
export const unreviewedPath = "src/audit/export.ts";

/** D1's limit on the parameters bound to one statement (`spec/research/platform.md`). */
const D1_MAX_PARAMS = 100;

/**
 * A test database that, once `enforce` is called, refuses a statement with
 * more bound parameters than D1 takes. `createTestDb` has no such limit, and
 * the demo seed is written before it applies.
 */
function createD1LimitedDb(): { db: Db; enforce: () => void } {
  const sqlite = new DatabaseSync(":memory:");
  for (const migration of migrations) {
    for (const statement of migration.statements) sqlite.exec(statement);
  }
  let enforced = false;
  const run = (sql: string, params: unknown[], method: "run" | "all" | "values" | "get") => {
    if (enforced && params.length > D1_MAX_PARAMS) {
      throw new Error(`too many SQL variables: ${params.length}`);
    }
    const statement = sqlite.prepare(sql);
    statement.setReturnArrays(true);
    const args = params as SQLInputValue[];
    if (method === "run") {
      statement.run(...args);
      return { rows: [] };
    }
    if (method === "get") return { rows: statement.get(...args) as unknown as unknown[] };
    return { rows: statement.all(...args) as unknown as unknown[][] };
  };
  const db = drizzle(
    async (sql, params, method) => run(sql, params, method),
    async (queries) => {
      sqlite.exec("BEGIN");
      try {
        const results = queries.map((query) => run(query.sql, query.params, query.method));
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
    { schema },
  );
  return {
    db,
    enforce: () => {
      enforced = true;
    },
  };
}

/** The demo, reviewable. With `d1Limits`, the database refuses what D1 would. */
export async function demoReview(options: { d1Limits?: boolean } = {}) {
  const limited = options.d1Limits ? createD1LimitedDb() : null;
  const db = limited?.db ?? createTestDb();
  await seedDemo(db);
  limited?.enforce();
  const { git, repos } = buildDemoGit();
  const ports = createFakePorts({ git, clock: new ManualClock(demo.now) });
  for (const session of demo.capturedSessions) {
    ports.capture.set({
      changeId: session.changeId,
      sessions: [session],
      missingCheckpointIds: [],
    });
  }
  ports.decisions.add(...structuredClone(demo.decisions));
  const deps: ReviewDeps = { ...ports, db };
  /** The thread's writer as the forge wires it, without the Durable Object around it. */
  const writer: ThreadHost = {
    post: (threadId, message) => appendMessage(deps, threadId, message),
  };
  return { db, deps, ports, git, repos, writer };
}

let threads = 0;

/** A thread on the demo's change under review, with these messages in order. */
export async function addThread(
  db: Db,
  messages: [author: User | "agent", body: string][],
  overrides: Partial<Thread> = {},
): Promise<ThreadId> {
  const id: ThreadId = `thr_test${++threads}`;
  const at = demo.now;
  const thread: Thread = {
    id,
    changeId: demoChanges.review.id,
    sectionId: null,
    kind: "comment",
    origin: "review",
    status: "open",
    finding: { category: "design", severity: "minor", title: "A design point", decisionIds: [] },
    anchor: { path: "src/invites/rate-limit.ts", side: "head", startLine: 12, endLine: 19 },
    anchorRevisionId: "rev_demo12a",
    dismissal: null,
    decisionId: null,
    createdBy: null,
    createdAt: at,
    settledAt: null,
    settledBy: null,
    learnedAt: null,
    messageCount: messages.length,
    lastMessageAt: at,
    ...overrides,
  };
  await db.insert(schema.threads).values(thread);
  if (messages.length > 0) {
    await db.insert(schema.threadMessages).values(
      messages.map(([author, body], index) =>
        fromThreadMessage({
          id: `msg_${id.slice(4)}_${index + 1}`,
          threadId: id,
          seq: index + 1,
          author: author === "agent" ? { kind: "agent" } : { kind: "user", userId: author.id },
          body,
          action: null,
          createdAt: at + index,
        }),
      ),
    );
  }
  return id;
}
