import { ForgeError } from "@gitflare/core";
import { createTestDb } from "@gitflare/db/testing";
import { createDecisionRecord, renderDecisionFile } from "@gitflare/decisions";
import { createFakePorts, ManualClock } from "@gitflare/testing";
import { buildDemoGit, demo, demoUsers } from "@gitflare/testing/demo";
import { createFixtureApi } from "@gitflare/testing/fixture-api";
import { seedDemo } from "@gitflare/testing/seed";
import { describe, expect, it } from "vitest";
import type { Services } from "../services";
import { decisionsApi } from "./decisions";

const maya = { user: demoUsers.maya };
const jonas = { user: demoUsers.jonas };
const byId = <T extends { id: string }>(rows: T[]) =>
  [...rows].sort((a, b) => (a.id < b.id ? -1 : 1));

/** The slice over a seeded database and the demo's git host, with the real decision record. */
async function demoSlice() {
  const db = createTestDb();
  await seedDemo(db);
  const { git, repos } = buildDemoGit(
    Object.fromEntries(demo.decisions.map((d) => [d.path, renderDecisionFile(d)])),
  );
  const ports = createFakePorts({ git, clock: new ManualClock(demo.now) });
  const decisions = createDecisionRecord({ ...ports, db });
  const services: Services = { ...ports, decisions, db, mode: "production" };
  return {
    api: decisionsApi(services),
    file: (path: string) => git.text(repos.context, "main", path),
  };
}

describe("the decisions slice", () => {
  it("serves the demo's record from the seeded database, as the fixture does", async () => {
    const { api } = await demoSlice();
    const fixture = createFixtureApi().decisions;

    const listed = await api.list(maya, { repoSlug: "atlas-web" });
    expect(listed).toEqual(await fixture.list(maya, { repoSlug: "atlas-web" }));
    expect(listed.map((d) => d.strength)).toEqual([0.83, 0.74, 0.66, 0.5, 0.11]);
    expect(await api.list(maya, { repoSlug: "atlas-web", status: "dormant" })).toEqual(
      await fixture.list(maya, { repoSlug: "atlas-web", status: "dormant" }),
    );

    for (const { id } of demo.decisions) {
      const detail = await api.get(maya, { decisionId: id });
      const expected = await fixture.get(maya, { decisionId: id });
      expect(detail.decision).toEqual(expected.decision);
      expect(byId(detail.events)).toEqual(byId(expected.events));
      const times = detail.events.map((event) => event.createdAt);
      expect(times).toEqual([...times].sort((a, b) => b - a));
    }
  });

  it("answers not_found for a repository or a decision that does not exist", async () => {
    const { api } = await demoSlice();
    await expect(api.list(maya, { repoSlug: "nope" })).rejects.toMatchObject({ code: "not_found" });
    await expect(api.get(maya, { decisionId: "dec_nope" })).rejects.toBeInstanceOf(ForgeError);
  });

  it("adds a decision by hand, in the caller's name, to the index and the context repo", async () => {
    const { api, file } = await demoSlice();
    const { decision, events } = await api.create(jonas, {
      repoSlug: "atlas-web",
      title: "Migrations are forward-only",
      statement: "A migration is never edited after it has merged; fix it with a new one.",
      rationale: "",
      globs: ["migrations/**"],
    });
    expect(decision).toMatchObject({
      origin: "manual",
      status: "active",
      strength: 0.5,
      scope: { kind: "paths", globs: ["migrations/**"] },
    });
    expect(events).toMatchObject([{ kind: "created", userId: demoUsers.jonas.id }]);
    expect(await file(decision.path)).toContain("# Migrations are forward-only");
    expect(await api.list(jonas, { repoSlug: "atlas-web" })).toContainEqual(decision);
  });

  it("edits a decision, then puts the wording back by reverting that edit", async () => {
    const { api, file } = await demoSlice();
    const decisionId = "dec_thin_routes";
    const before = (await api.get(maya, { decisionId })).decision;

    const edited = await api.edit(maya, {
      decisionId,
      title: before.title,
      statement: "A route only parses and responds.",
      rationale: before.rationale,
    });
    expect(edited.decision).toMatchObject({
      statement: "A route only parses and responds.",
      strength: before.strength,
    });
    expect(edited.events[0]).toMatchObject({
      kind: "reshaped",
      userId: demoUsers.maya.id,
      user: { name: demoUsers.maya.name },
      wording: { before: { statement: before.statement } },
    });
    expect(edited.repository).toEqual({ id: before.repositoryId, slug: "atlas-web" });

    const reverted = await api.revert(jonas, {
      decisionId,
      eventId: edited.events[0]?.id ?? "dev_x",
    });
    expect(reverted.decision.statement).toBe(before.statement);
    expect(reverted.events[0]).toMatchObject({
      kind: "reverted",
      userId: demoUsers.jonas.id,
      wording: { after: { statement: before.statement } },
    });
    expect(await file(before.path)).toContain(before.statement);
  });

  it("revives a dormant decision, and refuses for one that is not", async () => {
    const { api } = await demoSlice();
    const revived = await api.revive(maya, { decisionId: "dec_moment_for_dates" });
    expect(revived.decision).toMatchObject({ status: "active", strength: 0.5 });
    expect(revived.events[0]).toMatchObject({ kind: "revived", strengthBefore: 0.11 });
    expect(await api.list(maya, { repoSlug: "atlas-web", status: "dormant" })).toEqual([]);
    await expect(api.revive(maya, { decisionId: "dec_thin_routes" })).rejects.toMatchObject({
      code: "invalid",
    });
  });
});
