import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { Thread, ThreadId, User } from "@gitflare/core";
import { type Db, fromThreadMessage, schema } from "@gitflare/db";
import { migrations } from "@gitflare/db/migrations";
import { createTestDb } from "@gitflare/db/testing";
import { createFakePorts, ManualClock } from "@gitflare/testing";
import { buildDemoGit, demo, demoChanges } from "@gitflare/testing/demo";
import { seedDemo } from "@gitflare/testing/seed";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import { renderDecisionFile } from "../file";
import type { DecisionsDeps } from "../store";

export const atlas =
  demo.repositories[0] ??
  (() => {
    throw new Error("the demo has no repository");
  })();

/** The demo's decision files, as the context repo holds them. */
export function demoDecisionFiles(): Record<string, string> {
  return Object.fromEntries(demo.decisions.map((d) => [d.path, renderDecisionFile(d)]));
}

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
  return { db, enforce: () => (enforced = true) };
}

/**
 * The demo deployment with its decision record in both places: the index in
 * a seeded database, and the files on the context repo's `main`. With
 * `d1Limits`, the database refuses what D1 would.
 */
export async function demoRecord(options: { d1Limits?: boolean } = {}) {
  const limited = options.d1Limits ? createD1LimitedDb() : null;
  const db = limited?.db ?? createTestDb();
  await seedDemo(db);
  limited?.enforce();
  const { git, repos } = buildDemoGit(demoDecisionFiles());
  const ports = createFakePorts({ git, clock: new ManualClock(demo.now) });
  const deps: DecisionsDeps = {
    db,
    git,
    gitWriter: git,
    models: ports.models,
    clock: ports.clock,
    ids: ports.ids,
  };
  const file = (path: string) => git.text(repos.context, "main", path);
  /** How many commits gitflare has made to the context repo's `main`. */
  const commits = () =>
    git.pushes.filter((p) => p.repoName === repos.context && p.ref === "refs/heads/main").length;
  return { db, deps, git, ports, repos, file, commits };
}

let threads = 0;

/** A comment thread on the demo's change under review, with these messages in order. */
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
    status: "resolved",
    finding: { category: "design", severity: "minor", title: "A design point", decisionIds: [] },
    anchor: null,
    anchorRevisionId: null,
    dismissal: null,
    decisionId: null,
    createdBy: null,
    createdAt: at,
    settledAt: at,
    settledBy: null,
    learnedAt: null,
    messageCount: messages.length,
    lastMessageAt: at,
    ...overrides,
  };
  await db.insert(schema.threads).values(thread);
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
  return id;
}
