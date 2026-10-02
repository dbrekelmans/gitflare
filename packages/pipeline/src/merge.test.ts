import { mainRepoName } from "@gitflare/core";
import { schema } from "@gitflare/db";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  approveSection,
  closeChange,
  endSession,
  handlePush,
  mergeChange,
  revokeApproval,
} from "./index";
import { createWorld, findingOn, readyChange, type World } from "./world";

const sections = (world: World) =>
  world.db.select().from(schema.sections).orderBy(schema.sections.position);
const approvals = (world: World) => world.db.select().from(schema.approvals);

async function approveAll(world: World, changeId: Parameters<typeof approveSection>[2]) {
  for (const section of await sections(world)) {
    await approveSection(world.deps, world.reviewer, changeId, section.id);
  }
}

describe("mergeChange", () => {
  it("refuses with the blockers, and merges once they clear", async () => {
    const world = await createWorld();
    const { git, decisions, live } = world.ports;
    const { changeId } = await readyChange(
      world,
      { "src/b.ts": "export const b = 1;\n" },
      { review: findingOn("src/b.ts") },
    );

    const refusal = await mergeChange(world.deps, world.reviewer, changeId).catch((error) => error);
    expect(refusal).toMatchObject({ code: "not_ready" });
    expect(refusal.message).toMatch(/1 section is not approved/);
    expect(refusal.message).toMatch(/1 comment is still open/);
    expect(await world.change(changeId)).toMatchObject({ status: "ready", mergedAt: null });
    expect(await git.getRepo(world.session.forkRepo)).not.toBeNull();

    await approveAll(world, changeId);
    const stillOpen = await mergeChange(world.deps, world.reviewer, changeId).catch((e) => e);
    expect(stillOpen.message).not.toMatch(/section/);
    expect(stillOpen.message).toMatch(/1 comment is still open/);

    await world.db.update(schema.threads).set({ status: "resolved" });
    world.ports.clock.advance(60_000);
    const merged = await mergeChange(world.deps, world.reviewer, changeId);

    const tip = await git.resolveRef(mainRepoName("app"), "main");
    expect(merged).toMatchObject({
      status: "merged",
      mergedBy: world.reviewer.id,
      mergedAt: world.ports.clock.now(),
      mergeSha: tip,
    });
    expect(await git.text("app", "main", "src/b.ts")).toBe("export const b = 1;\n");
    const [repository] = await world.db.select().from(schema.repositories);
    expect(repository?.headSha).toBe(tip);
    expect(decisions.settled).toEqual([changeId]);
    expect(live.types(changeId).slice(-2)).toEqual(["change.merged", "change.status"]);

    // Merging ends the session and deletes its fork.
    expect(await git.getRepo(world.session.forkRepo)).toBeNull();
    expect(await world.sessionRow()).toMatchObject({
      status: "merged",
      endedAt: world.ports.clock.now(),
      forkDeletedAt: world.ports.clock.now(),
    });

    // Asked again, as a retry would: nothing more happens.
    const events = live.events.length;
    expect(await mergeChange(world.deps, world.reviewer, changeId)).toEqual(merged);
    expect(decisions.settled).toEqual([changeId]);
    expect(live.events).toHaveLength(events);
  });

  it("refuses a change whose stages have not settled", async () => {
    const world = await createWorld();
    const result = await handlePush(world.deps, world.push({ "src/b.ts": "b\n" }));
    if (result.kind !== "change") throw new Error("no change");
    const refusal = await mergeChange(world.deps, world.reviewer, result.changeId).catch((e) => e);
    expect(refusal).toMatchObject({ code: "not_ready" });
    expect(refusal.message).toMatch(/it is processing/);
    expect(refusal.message).toMatch(/CI is queued/);
  });

  it("leaves the change as it was when the merge conflicts", async () => {
    const world = await createWorld();
    const { git, decisions, live } = world.ports;
    const { changeId } = await readyChange(world, { "src/a.ts": "export const a = 2;\n" });
    await approveAll(world, changeId);
    // Someone else's change reached main first, in the same lines.
    const main = git.push("app", "main", { "src/a.ts": "export const a = 3;\n" }).after;
    const before = await world.change(changeId);
    const events = live.events.length;

    const refusal = await mergeChange(world.deps, world.reviewer, changeId).catch((error) => error);

    expect(refusal).toMatchObject({ code: "conflict" });
    expect(refusal.message).toMatch(/src\/a\.ts/);
    expect(await world.change(changeId)).toEqual(before);
    expect(before.status).toBe("ready");
    expect(await git.resolveRef("app", "main")).toBe(main);
    expect(await git.getRepo(world.session.forkRepo)).not.toBeNull();
    expect(await world.sessionRow()).toMatchObject({ status: "active", forkDeletedAt: null });
    expect(decisions.settled).toEqual([]);
    expect(live.events).toHaveLength(events);
  });

  it("merges the reviewed head, not a later push nobody has seen", async () => {
    const world = await createWorld();
    const { changeId } = await readyChange(world, { "src/b.ts": "reviewed\n" });
    await approveAll(world, changeId);
    world.push({ "src/b.ts": "unreviewed\n" });

    await mergeChange(world.deps, world.reviewer, changeId);

    expect(await world.ports.git.text("app", "main", "src/b.ts")).toBe("reviewed\n");
  });
});

describe("approving a section", () => {
  it("stores an author's own approval as a self-approval", async () => {
    const world = await createWorld();
    const { changeId } = await readyChange(world, { "src/b.ts": "b\n" });
    const [section] = await sections(world);
    if (!section) throw new Error("no section");

    const own = await approveSection(world.deps, world.author, changeId, section.id);
    const other = await approveSection(world.deps, world.reviewer, changeId, section.id);

    expect(own).toMatchObject({ userId: world.author.id, selfApproval: true });
    expect(other).toMatchObject({ userId: world.reviewer.id, selfApproval: false });
    expect((await approvals(world)).map((a) => [a.userId, a.selfApproval, a.contentHash])).toEqual([
      [world.author.id, true, section.contentHash],
      [world.reviewer.id, false, section.contentHash],
    ]);
    expect(world.ports.live.events.slice(-2)).toEqual([
      expect.objectContaining({ type: "section.approved", userId: world.author.id }),
      expect.objectContaining({ type: "section.approved", userId: world.reviewer.id }),
    ]);
  });

  it("counts one approval per person, and lets them take it back", async () => {
    const world = await createWorld();
    const { changeId } = await readyChange(world, { "src/b.ts": "b\n" });
    const [section] = await sections(world);
    if (!section) throw new Error("no section");

    const first = await approveSection(world.deps, world.reviewer, changeId, section.id);
    expect(await approveSection(world.deps, world.reviewer, changeId, section.id)).toEqual(first);
    expect(await approvals(world)).toHaveLength(1);

    world.ports.clock.advance(1_000);
    await revokeApproval(world.deps, world.reviewer, changeId, section.id);
    expect(await approvals(world)).toEqual([
      { ...first, withdrawnAt: world.ports.clock.now(), withdrawnReason: "revoked" },
    ]);
    expect(world.ports.live.events.at(-1)).toMatchObject({
      type: "section.approval_withdrawn",
      sectionId: section.id,
      userId: world.reviewer.id,
    });
    // The record of the first approval stays; approving again is a new one.
    await approveSection(world.deps, world.reviewer, changeId, section.id);
    expect(await approvals(world)).toHaveLength(2);
  });

  it("refuses a section of another change, and a change that is closed", async () => {
    const world = await createWorld();
    const { changeId } = await readyChange(world, { "src/b.ts": "b\n" });
    const [section] = await sections(world);
    if (!section) throw new Error("no section");
    await expect(
      approveSection(world.deps, world.reviewer, "chg_other", section.id),
    ).rejects.toMatchObject({ code: "not_found" });
    await closeChange(world.deps, world.author, changeId);
    await expect(
      approveSection(world.deps, world.reviewer, changeId, section.id),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(await approvals(world)).toHaveLength(0);
  });
});

describe("closeChange", () => {
  it("closes the change, ends the session and deletes the fork with its tokens", async () => {
    const world = await createWorld();
    const { git, live, decisions } = world.ports;
    const { changeId } = await readyChange(world, { "src/b.ts": "b\n" });
    const token = await git.mintToken(world.session.forkRepo, "write", 3600);
    await world.db.insert(schema.gitTokens).values({
      tokenId: token.id,
      repoName: world.session.forkRepo,
      userId: world.author.id,
      sessionId: world.session.id,
      scope: "write",
      purpose: "session_push",
      expiresAt: token.expiresAt,
      createdAt: world.ports.clock.now(),
    });

    // Not anyone's to close: only the author's or an administrator's.
    await expect(closeChange(world.deps, world.reviewer, changeId)).rejects.toMatchObject({
      code: "forbidden",
    });
    expect((await world.change(changeId)).status).toBe("ready");
    expect(await git.getRepo(world.session.forkRepo)).not.toBeNull();

    world.ports.clock.advance(60_000);
    const closed = await closeChange(world.deps, world.author, changeId);

    expect(closed).toMatchObject({ status: "closed", closedAt: world.ports.clock.now() });
    expect(live.events.at(-1)).toMatchObject({ type: "change.status", status: "closed" });
    expect(await git.getRepo(world.session.forkRepo)).toBeNull();
    expect(git.tokens.map((issued) => issued.revoked)).toEqual([true]);
    expect(await world.sessionRow()).toMatchObject({
      status: "abandoned",
      forkDeletedAt: world.ports.clock.now(),
    });
    const [grant] = await world.db.select().from(schema.gitTokens);
    expect(grant?.revokedAt).toBe(world.ports.clock.now());
    // Nothing merged: main is where it was and no decision was settled.
    expect(await git.resolveRef("app", "main")).toBe(world.base);
    expect(decisions.settled).toEqual([]);

    await expect(mergeChange(world.deps, world.reviewer, changeId)).rejects.toMatchObject({
      code: "not_ready",
    });
    expect(await closeChange(world.deps, world.admin, changeId)).toEqual(closed);
  });

  it("refuses a merged change", async () => {
    const world = await createWorld();
    const { changeId } = await readyChange(world, { "src/b.ts": "b\n" });
    await approveAll(world, changeId);
    await mergeChange(world.deps, world.reviewer, changeId);
    await expect(closeChange(world.deps, world.author, changeId)).rejects.toMatchObject({
      code: "conflict",
    });
    expect(await world.sessionRow()).toMatchObject({ status: "merged" });
  });
});

describe("endSession", () => {
  it("ends a session that never opened a change, once", async () => {
    const world = await createWorld();
    const { git, clock } = world.ports;
    const ended = await endSession(world.deps, world.session.id, "abandoned");
    expect(ended).toMatchObject({
      status: "abandoned",
      endedAt: clock.now(),
      forkDeletedAt: clock.now(),
    });
    expect(await git.getRepo(world.session.forkRepo)).toBeNull();

    clock.advance(60_000);
    expect(await endSession(world.deps, world.session.id, "merged")).toEqual(ended);
    await expect(endSession(world.deps, "ses_missing", "abandoned")).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("finishes deleting a fork when an earlier call ended the session and then failed", async () => {
    const world = await createWorld();
    const { git } = world.ports;
    await world.db
      .update(schema.sessions)
      .set({ status: "merged", endedAt: 1 })
      .where(eq(schema.sessions.id, world.session.id));

    const ended = await endSession(world.deps, world.session.id, "merged");

    expect(ended).toMatchObject({ status: "merged", endedAt: 1 });
    expect(ended.forkDeletedAt).not.toBeNull();
    expect(await git.getRepo(world.session.forkRepo)).toBeNull();
  });
});
