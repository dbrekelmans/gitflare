import { migrations } from "@gitflare/db/migrations";
import { seedDemo } from "@gitflare/testing/seed";
import type { Services } from "./services";

let ready: Promise<void> | undefined;

/**
 * Local development only: brings this machine's D1 up to date and loads the
 * demo into it, once per isolate. Migrations are recorded in the same
 * `d1_migrations` table Wrangler uses, so `wrangler d1 migrations apply
 * --local` and this agree on what has been applied.
 */
export function ensureDevDatabase(services: Services, d1: D1Database): Promise<void> {
  ready ??= (async () => {
    await d1
      .prepare(
        "CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)",
      )
      .run();
    const applied = await d1.prepare("SELECT name FROM d1_migrations").all<{ name: string }>();
    const done = new Set(applied.results.map((row) => row.name));
    for (const migration of migrations) {
      if (done.has(migration.name)) continue;
      await d1.batch([
        ...migration.statements.map((statement) => d1.prepare(statement)),
        d1.prepare("INSERT INTO d1_migrations (name) VALUES (?)").bind(migration.name),
      ]);
    }
    await seedDemo(services.db);
  })();
  return ready;
}
