import { describe, expect, it, vi } from "vitest";
import {
  approveSection,
  CHECKPOINT_WAIT_MS,
  changeDetail,
  handlePush,
  listChanges,
  missingCheckpoints,
  sectionDiff,
} from "./index";
import { createWorld, readyChange, runStages } from "./world";

const CHECKPOINT = "0123456789ab";

describe("the capture a change page shows", () => {
  it("is pending while the pipeline waits, then missing, and present once it arrives", async () => {
    const world = await createWorld();
    const { capture, clock } = world.ports;
    const result = await handlePush(
      world.deps,
      world.push({ "src/b.ts": "b\n" }, `Add b\n\nEntire-Checkpoint: ${CHECKPOINT}`),
    );
    if (result.kind !== "change") throw new Error("no change");
    capture.missing.set(result.changeId, [CHECKPOINT]);
    const state = async () => (await changeDetail(world.deps, result.changeId)).capture;

    expect(await missingCheckpoints(world.deps, result.changeId)).toEqual([CHECKPOINT]);
    expect(await state()).toMatchObject({ state: "pending", missingCheckpointIds: [CHECKPOINT] });

    // The wait is bounded: after it, the change goes on and says what never came.
    clock.advance(CHECKPOINT_WAIT_MS);
    expect((await state()).state).toBe("missing");
    await runStages(world, result);
    expect(await state()).toMatchObject({ state: "missing", missingCheckpointIds: [CHECKPOINT] });

    capture.missing.delete(result.changeId);
    expect(await state()).toMatchObject({ state: "present", missingCheckpointIds: [] });
  });

  it("stops being pending as soon as the stages start", async () => {
    const world = await createWorld();
    const result = await handlePush(
      world.deps,
      world.push({ "src/b.ts": "b\n" }, `Add b\n\nEntire-Checkpoint: ${CHECKPOINT}`),
    );
    if (result.kind !== "change") throw new Error("no change");
    world.ports.capture.missing.set(result.changeId, [CHECKPOINT]);
    await runStages(world, { ...result, stages: result.stages.slice(0, 1) });
    expect((await changeDetail(world.deps, result.changeId)).capture.state).toBe("missing");
  });

  it("is none for commits that name no checkpoint, without asking", async () => {
    const world = await createWorld();
    const asked = vi.spyOn(world.ports.capture, "missingCheckpoints");
    const { changeId } = await readyChange(world, { "src/b.ts": "b\n" });
    expect(await missingCheckpoints(world.deps, changeId)).toEqual([]);
    expect((await changeDetail(world.deps, changeId)).capture).toEqual({
      state: "none",
      sessions: [],
      missingCheckpointIds: [],
    });
    expect(asked).not.toHaveBeenCalled();
  });
});

describe("the change views", () => {
  it("shows each section's own part of the diff and who approved it", async () => {
    const world = await createWorld();
    const { changeId } = await readyChange(world, {
      "src/a.ts": "export const a = 2;\n",
      "src/b.ts": "one\ntwo\n",
    });
    let detail = await changeDetail(world.deps, changeId);
    expect(
      detail.sections.map((s) => [s.section.title, s.filesChanged, s.insertions, s.deletions]),
    ).toEqual([
      ["src/a.ts", 1, 1, 1],
      ["src/b.ts", 1, 2, 0],
    ]);
    expect(detail.readiness.blockers).toEqual([
      { kind: "sections_unapproved", sectionIds: detail.sections.map((s) => s.section.id) },
    ]);

    const [first, second] = detail.sections.map((s) => s.section.id);
    if (!first || !second) throw new Error("no sections");
    await approveSection(world.deps, world.author, changeId, first);
    detail = await changeDetail(world.deps, changeId);
    expect(detail.sections.map((s) => s.approvalState)).toEqual(["approved", "pending"]);
    expect(detail.sections[0]?.approvals).toEqual([
      expect.objectContaining({
        selfApproval: true,
        user: { id: world.author.id, name: "ada", email: "ada@example.com" },
      }),
    ]);
    expect(detail.readiness.blockers).toEqual([
      { kind: "sections_unapproved", sectionIds: [second] },
    ]);

    const diff = await sectionDiff(world.deps, changeId, second);
    expect(diff.files.map((file) => [file.path, file.status, file.insertions])).toEqual([
      ["src/b.ts", "added", 2],
    ]);
    await expect(sectionDiff(world.deps, changeId, "sec_missing")).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("lists what waits on the caller in their inbox, and their own work under mine", async () => {
    const world = await createWorld();
    const { changeId } = await readyChange(world, { "src/b.ts": "b\n" });
    const other = await world.startSession(world.reviewer, "Still running");
    world.ports.clock.advance(1_000);
    await handlePush(world.deps, world.push({ "c.ts": "c\n" }, "Work", other));
    const titles = async (user: typeof world.author, scope: "inbox" | "mine" | "all") =>
      (await listChanges(world.deps, user, { scope })).map((summary) => summary.change.title);

    expect(await titles(world.reviewer, "all")).toEqual(["Still running", "Add b"]);
    expect(await titles(world.reviewer, "mine")).toEqual(["Still running"]);
    // Ready, not theirs, with a section they have not approved.
    expect(await titles(world.reviewer, "inbox")).toEqual(["Add b"]);
    expect(await titles(world.author, "inbox")).toEqual([]);

    const [section] = (await changeDetail(world.deps, changeId)).sections;
    if (!section) throw new Error("no section");
    await approveSection(world.deps, world.reviewer, changeId, section.section.id);
    expect(await titles(world.reviewer, "inbox")).toEqual([]);
    // Someone else's approval does not take it out of the administrator's inbox.
    expect(await titles(world.admin, "inbox")).toEqual(["Add b"]);

    const [summary] = await listChanges(world.deps, world.admin, {
      scope: "all",
      statuses: ["ready"],
    });
    expect(summary).toMatchObject({
      sectionsTotal: 1,
      sectionsApproved: 1,
      openComments: 0,
      needsYou: true,
    });
    await expect(
      listChanges(world.deps, world.admin, { scope: "all", repoSlug: "nowhere" }),
    ).rejects.toMatchObject({ code: "not_found" });
  });
});
