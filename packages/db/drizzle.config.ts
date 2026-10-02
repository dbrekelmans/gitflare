import { defineConfig } from "drizzle-kit";

// `pnpm --filter @gitflare/db generate` writes the next SQL file into
// ./migrations. Wrangler applies them to D1 (`wrangler d1 migrations apply`);
// drizzle-kit never talks to a database here.
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/schema.ts",
  out: "./migrations",
});
