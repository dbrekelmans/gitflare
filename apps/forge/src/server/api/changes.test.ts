import type { ApiContext } from "@gitflare/core/api";
import { schema } from "@gitflare/db";
import { createTestDb } from "@gitflare/db/testing";
import { createDemoPorts } from "@gitflare/testing";
import { demo, demoChanges, demoUsers } from "@gitflare/testing/demo";
import { createFixtureApi } from "@gitflare/testing/fixture-api";
import { seedDemo } from "@gitflare/testing/seed";
import { describe, expect, it } from "vitest";
import type { Services } from "../services";
import { changesApi } from "./changes";
import { devApi } from "./dev";

// The slice over the seeded database, held against the fixture API: the same
// demo, served by the code screens were built on.

async function seeded() {
  const db = createTestDb();
  await seedDemo(db);
  const ports = createDemoPorts();
  const services: Services = { ...ports, db, mode: "dev" };
  return { db, ports, services, api: changesApi(services), fixture: createFixtureApi().changes };
}

const as = (user: (typeof demoUsers)[keyof typeof demoUsers]): ApiContext => ({ user });
const everyone = Object.values(demoUsers);

describe("the changes slice, reading the demo", () => {
  it("returns each change's page as the fixture does", async () => {
    const { api, fixture } = await seeded();
    for (const { id: changeId } of demo.changes) {
      expect(await api.get(as(demoUsers.maya), { changeId })).toEqual(
        await fixture.get(as(demoUsers.maya), { changeId }),
      );
    }
    // And that page is the demo's story, not two empty views agreeing.
    const review = await api.get(as(demoUsers.maya), { changeId: demoChanges.review.id });
    expect(review.sections.map((view) => view.approvalState)).toEqual([
      "approved",
      "pending",
      "withdrawn",
      "approved",
    ]);
    expect(review.sections.every((view) => view.filesChanged > 0 && view.insertions > 0)).toBe(
      true,
    );
    expect(review.capture.state).toBe("present");
    expect(review.intent?.grade).toBe("transcript");
    expect(review.stages.map((run) => run.status)).toEqual([
      "skipped",
      "succeeded",
      "succeeded",
      "succeeded",
    ]);
    expect(review.readiness.blockers.map((blocker) => blocker.kind)).toEqual([
      "sections_unapproved",
      "comments_open",
    ]);
    expect(review.cost.totalMicroUsd).toBeGreaterThan(0);
    expect(review.lastEventSeq).toBe(19);
  });

  it("lists changes for every person and scope as the fixture does", async () => {
    const { api, fixture } = await seeded();
    for (const user of everyone) {
      for (const scope of ["all", "mine", "inbox"] as const) {
        expect(await api.list(as(user), { scope })).toEqual(
          await fixture.list(as(user), { scope }),
        );
      }
    }
    const numbers = async (user: ApiContext, input: Parameters<typeof api.list>[1]) =>
      (await api.list(user, input)).map((summary) => summary.change.number);
    expect(await numbers(as(demoUsers.maya), { scope: "all" })).toEqual([13, 12, 11]);
    expect(await numbers(as(demoUsers.maya), { scope: "inbox" })).toEqual([12]);
    expect(await numbers(as(demoUsers.jonas), { scope: "inbox" })).toEqual([]);
    expect(await numbers(as(demoUsers.jonas), { scope: "mine" })).toEqual([12]);
    expect(await numbers(as(demoUsers.maya), { scope: "all", statuses: ["merged"] })).toEqual([11]);
    expect(await numbers(as(demoUsers.maya), { scope: "all", repoSlug: "billing-worker" })).toEqual(
      [],
    );
  });

  it("returns every section's diff and the head revision's CI as the fixture does", async () => {
    const { api, fixture } = await seeded();
    const ctx = as(demoUsers.maya);
    for (const { changeId, id: sectionId } of demo.sections) {
      const diff = await api.sectionDiff(ctx, { changeId, sectionId });
      expect(diff).toEqual(await fixture.sectionDiff(ctx, { changeId, sectionId }));
      expect(diff.files.length).toBeGreaterThan(0);
    }
    for (const { id: changeId } of demo.changes) {
      expect(await api.ci(ctx, { changeId })).toEqual(await fixture.ci(ctx, { changeId }));
    }
    const { run, steps } = await api.ci(ctx, { changeId: demoChanges.cloud.id });
    expect(run?.status).toBe("running");
    expect(steps.map((step) => [step.name, step.status])).toEqual([
      ["typecheck", "succeeded"],
      ["lint", "running"],
      ["test", "queued"],
    ]);
  });
});

describe("the changes slice, acting on the demo", () => {
  const changeId = demoChanges.review.id;

  it("approves a section, and marks the author's own approval as one", async () => {
    const { api } = await seeded();
    const approved = await api.approveSection(as(demoUsers.maya), {
      changeId,
      sectionId: "sec_demo12route",
    });
    expect(approved.sections[1]).toMatchObject({ approvalState: "approved" });
    expect(approved.sections[1]?.approvals[0]).toMatchObject({
      selfApproval: false,
      user: { id: demoUsers.maya.id },
    });
    expect(approved.readiness.blockers[0]).toEqual({
      kind: "sections_unapproved",
      sectionIds: ["sec_demo12tests"],
    });

    const own = await api.approveSection(as(demoUsers.jonas), {
      changeId,
      sectionId: "sec_demo12tests",
    });
    expect(own.sections[2]?.approvals[0]).toMatchObject({
      selfApproval: true,
      user: { id: demoUsers.jonas.id },
    });

    const revoked = await api.revokeApproval(as(demoUsers.maya), {
      changeId,
      sectionId: "sec_demo12route",
    });
    expect(revoked.sections[1]).toMatchObject({ approvalState: "withdrawn" });
    expect(revoked.lastEventSeq).toBe(22);
  });

  it("refuses to merge with the blockers, then merges and deletes the fork", async () => {
    const { api, db, ports } = await seeded();
    const ctx = as(demoUsers.maya);
    await expect(api.merge(ctx, { changeId })).rejects.toMatchObject({
      code: "not_ready",
      message: expect.stringMatching(/2 sections are not approved; 1 comment is still open/),
    });

    await api.approveSection(ctx, { changeId, sectionId: "sec_demo12route" });
    await api.approveSection(ctx, { changeId, sectionId: "sec_demo12tests" });
    await db.update(schema.threads).set({ status: "resolved" });
    const merged = await api.merge(ctx, { changeId });

    expect(merged.change).toMatchObject({ status: "merged", mergedBy: demoUsers.maya.id });
    expect(merged.session).toMatchObject({ status: "merged" });
    expect(merged.session.forkDeletedAt).not.toBeNull();
    expect(await ports.git.getRepo(demo.git.repos.forks.review)).toBeNull();
    expect(await ports.git.resolveRef(demo.git.repos.main, "main")).toBe(
      demoChanges.review.headSha,
    );
    // The page still has its diff: it is read from the main repo now.
    expect(merged.sections.every((view) => view.filesChanged > 0)).toBe(true);
  });

  it("queues a re-run and hands it to the pipeline", async () => {
    const { api, ports } = await seeded();
    const detail = await api.rerunStage(as(demoUsers.priya), { changeId, stage: "review" });
    expect(detail.change.status).toBe("processing");
    expect(detail.stages.find((run) => run.stage === "review")).toMatchObject({
      attempt: 2,
      status: "queued",
    });
    expect(ports.pipeline.reruns).toEqual([{ changeId, stage: "review", attempt: 2 }]);
  });

  it("closes a change for its author or an administrator only", async () => {
    const { api, ports } = await seeded();
    await expect(api.close(as(demoUsers.priya), { changeId })).rejects.toMatchObject({
      code: "forbidden",
    });
    const closed = await api.close(as(demoUsers.jonas), { changeId });
    expect(closed.change.status).toBe("closed");
    expect(closed.session.status).toBe("abandoned");
    expect(await ports.git.getRepo(demo.git.repos.forks.review)).toBeNull();
  });
});

describe("the dev slice", () => {
  const push = { repoName: "atlas-web.fork.x", ref: "refs/heads/work", before: "0", after: "1" };

  it("raises a push through the pipeline in local development", async () => {
    const { services, ports } = await seeded();
    await devApi(services).simulatePush(as(demoUsers.maya), push);
    expect(ports.pipeline.pushes).toEqual([push]);
  });

  it("refuses everything in production", async () => {
    const { services, ports } = await seeded();
    const production = devApi({ ...services, mode: "production" });
    await expect(production.simulatePush(as(demoUsers.maya), push)).rejects.toMatchObject({
      code: "forbidden",
    });
    expect(ports.pipeline.pushes).toEqual([]);
  });
});
