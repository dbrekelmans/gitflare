import { env } from "cloudflare:workers";
import { createD1Db } from "@gitflare/db/d1";
import { recordDecisionEvent } from "@gitflare/decisions";
import { createDemoPorts } from "@gitflare/testing";
import { demoUsers } from "@gitflare/testing/demo";
import { expect, it } from "vitest";
import { ensureDevDatabase } from "../dev";
import type { Services } from "../services";
import { decisionsApi } from "./decisions";

// The decision record against local D1, as `pnpm dev` runs it: an event and
// the decision's new state are one guarded batch, which has to hold on D1
// itself and not only on the SQLite the Node tests use.

const maya = { user: demoUsers.maya };

// One set of ports for the file: the database outlives a test, and so must the id counter.
let shared: Services | undefined;

async function services(): Promise<Services> {
  shared ??= { ...createDemoPorts(), db: createD1Db(env.DB), mode: "dev" };
  await ensureDevDatabase(shared, env.DB);
  return shared;
}

it("applies events that land on one decision at once, each on top of another", async () => {
  const deps = await services();
  const api = decisionsApi(deps);
  const decisionId = "dec_thin_routes";
  const confirmed = {
    kind: "confirmed" as const,
    userId: maya.user.id,
    changeId: null,
    threadId: null,
    note: null,
  };

  await Promise.all([
    recordDecisionEvent(deps, decisionId, confirmed),
    recordDecisionEvent(deps, decisionId, confirmed),
    recordDecisionEvent(deps, decisionId, confirmed),
  ]);

  const { decision, events } = await api.get(maya, { decisionId });
  const mine = events.filter(
    (event) => event.kind === "confirmed" && event.userId === maya.user.id,
  );
  expect(mine).toHaveLength(3);
  expect(new Set(mine.map((event) => event.strengthBefore)).size).toBe(3);
  // Three confirmations from 0.74: 1 − 0.26 × 0.75³.
  expect(decision.strength).toBeCloseTo(0.8903125, 10);
  expect(
    await deps.git.readFile("atlas-web.context", { ref: "main", path: decision.path }),
  ).not.toBeNull();
});

it("edits, reverts and revives through the slice", async () => {
  const api = decisionsApi(await services());
  const decisionId = "dec_counters_in_durable_objects";
  const before = (await api.get(maya, { decisionId })).decision;

  const edited = await api.edit(maya, {
    decisionId,
    title: before.title,
    statement: "Counters go in a Durable Object.",
    rationale: before.rationale,
  });
  expect(edited.decision.statement).toBe("Counters go in a Durable Object.");
  const reverted = await api.revert(maya, { decisionId, eventId: edited.events[0]?.id ?? "dev_x" });
  expect(reverted.decision.statement).toBe(before.statement);
  expect(reverted.events.slice(0, 2).map((event) => event.kind)).toEqual(["reverted", "reshaped"]);

  const revived = await api.revive(maya, { decisionId: "dec_moment_for_dates" });
  expect(revived.decision).toMatchObject({ status: "active", strength: 0.5 });
});
