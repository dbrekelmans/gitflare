import { env } from "cloudflare:workers";
import { schema } from "@gitflare/db";
import { createD1Db } from "@gitflare/db/d1";
import { createFakePorts } from "@gitflare/testing";
import { demo } from "@gitflare/testing/demo";
import { expect, it } from "vitest";
import { authenticate } from "./auth";
import { ensureDevDatabase } from "./dev";
import type { Services } from "./services";

// Runs in workerd against local D1: the same database `pnpm dev` uses.

function services(): Services {
  return { ...createFakePorts(), db: createD1Db(env.DB), mode: "dev" };
}

it("migrates and seeds local D1 once, and records the migrations as Wrangler would", async () => {
  const deps = services();
  await ensureDevDatabase(deps, env.DB);
  await ensureDevDatabase(deps, env.DB);
  expect((await deps.db.select().from(schema.changes)).length).toBe(demo.changes.length);
  expect((await deps.db.select().from(schema.threadMessages)).length).toBe(demo.messages.length);
  const applied = await env.DB.prepare("SELECT name FROM d1_migrations").all<{ name: string }>();
  expect(applied.results.map((row) => row.name)).toEqual(["0000_initial.sql"]);
});

it("signs the demo's viewer in from the seeded database", async () => {
  const deps = services();
  await ensureDevDatabase(deps, env.DB);
  const { subject, email, name } = demo.viewer;
  deps.identity = { identify: async () => ({ subject, email, name }) };
  const user = await authenticate(deps, new Headers(), { firstAdminEmail: null });
  expect(user).toMatchObject({ id: demo.viewer.id, role: "admin" });
  deps.identity = { identify: async () => null };
  await expect(authenticate(deps, new Headers(), { firstAdminEmail: null })).rejects.toMatchObject({
    code: "unauthenticated",
  });
});

it("reaches the Durable Objects and Workflows the config declares", async () => {
  expect((await env.CHANGE_ROOM.getByName("chg_1").fetch("https://forge/live")).status).toBe(501);
  expect(env.THREAD_ROOM.getByName("thr_1")).toBeDefined();
  expect(env.CHANGE_PIPELINE).toBeDefined();
  expect(env.CI).toBeDefined();
});
