import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import type { Db } from "./index";
import { migrations } from "./migrations";
import * as schema from "./schema";

/**
 * A fresh in-memory database with every migration applied, for Node tests. It
 * answers the same Drizzle queries D1 does, including `db.batch`, which here
 * runs inside one SQLite transaction.
 */
export function createTestDb(): Db {
  const sqlite = new DatabaseSync(":memory:");
  for (const migration of migrations) {
    for (const statement of migration.statements) sqlite.exec(statement);
  }

  const run = (sql: string, params: unknown[], method: "run" | "all" | "values" | "get") => {
    const statement = sqlite.prepare(sql);
    statement.setReturnArrays(true);
    const args = params as SQLInputValue[];
    if (method === "run") {
      statement.run(...args);
      return { rows: [] };
    }
    if (method === "get") {
      return { rows: statement.get(...args) as unknown as unknown[] };
    }
    return { rows: statement.all(...args) as unknown as unknown[][] };
  };

  return drizzle(
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
}
