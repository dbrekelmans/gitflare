/// <reference types="vite/client" />

// The migration files as text, in order. Vite inlines them, so this works in
// the Worker bundle and under Vitest alike. Production applies the same files
// with `wrangler d1 migrations apply`; this list is for local development and
// tests, where the forge sets its own database up.
const files = import.meta.glob<string>("../migrations/*.sql", {
  query: "?raw",
  import: "default",
  eager: true,
});

export interface Migration {
  name: string;
  /** One SQL statement per entry. */
  statements: string[];
}

export const migrations: Migration[] = Object.keys(files)
  .sort()
  .map((path) => ({
    name: path.slice(path.lastIndexOf("/") + 1),
    statements: (files[path] ?? "")
      .split("--> statement-breakpoint")
      .map((statement) => statement.trim())
      .filter((statement) => statement.length > 0),
  }));
