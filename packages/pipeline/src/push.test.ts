import { CHECKPOINT_REF_PREFIX, contextRepoName, stageNames } from "@gitflare/core";
import { schema, toRevision } from "@gitflare/db";
import { describe, expect, it, vi } from "vitest";
import { closeChange, handlePush, type PushResult } from "./index";
import { createWorld, runStages, type World } from "./world";

const CHECKPOINT = "01M3YB2T7QH8ZK4N5V6W9XACD1";

function changeOf(result: PushResult) {
  if (result.kind !== "change")
    throw new Error(`the push was ${result.kind}: ${JSON.stringify(result)}`);
  return result;
}

async function rows(world: World) {
  const { db } = world;
  return {
    changes: await db.select().from(schema.changes),
    revisions: (await db.select().from(schema.revisions).orderBy(schema.revisions.number)).map(
      toRevision,
    ),
    commits: await db.select().from(schema.changeCommits).orderBy(schema.changeCommits.position),
    stageRuns: await db.select().from(schema.stageRuns),
    events: await db.select().from(schema.changeEvents),
  };
}

describe("handlePush", () => {
  it("opens a change for the first branch a session pushes", async () => {
    const world = await createWorld();
    world.push(
      { "src/b.ts": "export const b = 1;\n" },
      `Add b\n\nEntire-Checkpoint: ${CHECKPOINT}`,
    );
    const push = world.push({ "src/a.ts": "export const a = 2;\n" }, "Change a");

    const result = changeOf(await handlePush(world.deps, push));

    expect(result.opened).toBe(true);
    const change = await world.change(result.changeId);
    expect(change).toMatchObject({
      repositoryId: world.repository.id,
      sessionId: world.session.id,
      number: 1,
      title: world.session.title,
      status: "processing",
      authorId: world.author.id,
      headRef: "refs/heads/work",
      baseSha: world.base,
      headSha: push.after,
      headRevisionId: result.revisionId,
    });

    const { revisions, commits, stageRuns } = await rows(world);
    expect(revisions).toEqual([
      expect.objectContaining({
        id: result.revisionId,
        number: 1,
        baseSha: world.base,
        headSha: push.after,
        stats: { commits: 2, filesChanged: 2, insertions: 2, deletions: 1 },
      }),
    ]);
    // Both commits since the base, oldest first, although the event was for the second one only.
    expect(commits.map((c) => [c.message.split("\n")[0], c.checkpointIds])).toEqual([
      ["Add b", [CHECKPOINT]],
      ["Change a", []],
    ]);
    expect(stageRuns.map((run) => [run.stage, run.attempt, run.status, run.revisionId])).toEqual(
      stageNames.map((stage) => [stage, 1, "queued", result.revisionId]),
    );
    expect(result.stages).toEqual(stageRuns);
    expect(world.ports.live.events).toEqual([
      expect.objectContaining({ type: "change.status", status: "processing", seq: 1 }),
    ]);
  });

  it("numbers changes per repository in the order they open", async () => {
    const world = await createWorld();
    const other = await world.startSession(world.reviewer, "Another piece of work");
    const first = changeOf(await handlePush(world.deps, world.push({ "b.ts": "b\n" })));
    const second = changeOf(
      await handlePush(world.deps, world.push({ "c.ts": "c\n" }, "Work", other)),
    );
    expect((await world.change(first.changeId)).number).toBe(1);
    expect(await world.change(second.changeId)).toMatchObject({
      number: 2,
      authorId: world.reviewer.id,
      title: "Another piece of work",
    });
  });

  it("adds a revision when the branch is pushed again", async () => {
    const world = await createWorld();
    const one = world.push({ "src/b.ts": "1\n" }, "One");
    const first = changeOf(await handlePush(world.deps, one));
    await runStages(world, first);
    expect((await world.change(first.changeId)).status).toBe("ready");

    world.ports.clock.advance(60_000);
    const push = world.push({ "src/b.ts": "2\n" }, "Two");
    const second = changeOf(await handlePush(world.deps, push));

    expect(second).toMatchObject({ changeId: first.changeId, opened: false });
    expect(second.revisionId).not.toBe(first.revisionId);
    expect(await world.change(first.changeId)).toMatchObject({
      status: "processing",
      headSha: push.after,
      headRevisionId: second.revisionId,
      readyAt: null,
    });
    const { changes, revisions, commits, stageRuns } = await rows(world);
    expect(changes).toHaveLength(1);
    expect(revisions.map((r) => [r.number, r.headSha, r.stats.commits])).toEqual([
      [1, one.after, 1],
      [2, push.after, 2],
    ]);
    // The first commit stays with the revision that brought it.
    expect(commits.map((c) => [c.message, c.revisionId])).toEqual([
      ["One", first.revisionId],
      ["Two", second.revisionId],
    ]);
    expect(second.stages.map((run) => [run.stage, run.attempt, run.status])).toEqual(
      stageNames.map((stage) => [stage, 1, "queued"]),
    );
    expect(stageRuns).toHaveLength(8);
    expect(world.ports.live.types(first.changeId).slice(-2)).toEqual([
      "revision.pushed",
      "change.status",
    ]);
    expect(world.ports.live.events.at(-2)).toMatchObject({
      revisionId: second.revisionId,
      number: 2,
    });
  });

  it("adds nothing when the same push is delivered twice", async () => {
    const world = await createWorld();
    const push = world.push({ "src/b.ts": "1\n" });
    const first = await handlePush(world.deps, push);
    const before = await rows(world);

    const again = await handlePush(world.deps, push);

    expect(await rows(world)).toEqual(before);
    expect(again).toEqual({ ...first, opened: false });
  });

  it("ends at the same revision whatever order pushes are delivered in", async () => {
    const inOrder = await createWorld();
    const a = inOrder.push({ "src/b.ts": "1\n" }, "One");
    await handlePush(inOrder.deps, a);
    const b = inOrder.push({ "src/b.ts": "2\n" }, "Two");
    const last = changeOf(await handlePush(inOrder.deps, b));
    // The first event again, long after: it must not move the head back.
    expect(await handlePush(inOrder.deps, a)).toMatchObject({ revisionId: last.revisionId });

    const reversed = await createWorld();
    const a2 = reversed.push({ "src/b.ts": "1\n" }, "One");
    const b2 = reversed.push({ "src/b.ts": "2\n" }, "Two");
    const early = changeOf(await handlePush(reversed.deps, b2));
    const late = changeOf(await handlePush(reversed.deps, a2));

    expect(late.revisionId).toBe(early.revisionId);
    const [there, here] = [
      await inOrder.change(last.changeId),
      await reversed.change(late.changeId),
    ];
    expect(here.headSha).toBe(b2.after);
    expect(here.headSha).toBe(there.headSha);
    expect(here.headRevisionId).toBe(late.revisionId);
    // Both commits are the change's, in either world.
    expect((await rows(reversed)).commits.map((c) => c.message)).toEqual(["One", "Two"]);
    expect((await rows(inOrder)).commits.map((c) => c.message)).toEqual(["One", "Two"]);
  });

  it("returns to an earlier revision when the branch is moved back to it", async () => {
    const world = await createWorld();
    const a = world.push({ "src/b.ts": "1\n" }, "One");
    const first = changeOf(await handlePush(world.deps, a));
    await runStages(world, first);
    await handlePush(world.deps, world.push({ "src/b.ts": "2\n" }, "Two"));

    // A force push back to the first commit.
    vi.spyOn(world.ports.git, "resolveRef").mockResolvedValue(a.after);
    const back = changeOf(await handlePush(world.deps, a));

    expect(back.revisionId).toBe(first.revisionId);
    expect(await world.change(first.changeId)).toMatchObject({
      headSha: a.after,
      headRevisionId: first.revisionId,
      status: "processing",
    });
    expect((await rows(world)).revisions).toHaveLength(2);
    // What ran for that revision before ran against other sections: every stage runs again.
    expect(back.stages.map((run) => [run.stage, run.attempt, run.status])).toEqual(
      stageNames.map((stage) => [stage, 2, "queued"]),
    );
  });

  it("ignores what is not a session's change", async () => {
    const world = await createWorld();
    const { git } = world.ports;
    const ignored = async (push: Parameters<typeof handlePush>[1]) => {
      const result = await handlePush(world.deps, push);
      expect(result.kind).toBe("ignored");
      return result.kind === "ignored" ? result.reason : "";
    };

    await ignored(git.push("app", "main", { "x.ts": "x\n" }));
    expect(
      await ignored({ ...world.push({ "b.ts": "b\n" }), repoName: "app.fork.999999" }),
    ).toMatch(/no session/);
    // The push above reached the fork; its change opens with the next event for that branch.
    const opened = changeOf(await handlePush(world.deps, world.push({ "c.ts": "c\n" })));

    // The session's change is the first branch pushed, and only that one.
    expect(await ignored(git.push(world.session.forkRepo, "other", { "d.ts": "d\n" }))).toMatch(
      /another branch/,
    );
    expect((await rows(world)).changes).toHaveLength(1);

    await closeChange(world.deps, world.author, opened.changeId);
    expect(
      await ignored({
        repoName: world.session.forkRepo,
        ref: "refs/heads/work",
        before: "0".repeat(40),
        after: "1".repeat(40),
      }),
    ).toMatch(/ended/);
  });

  it("ignores a branch that has nothing beyond the session's base", async () => {
    const world = await createWorld();
    vi.spyOn(world.ports.git, "resolveRef").mockResolvedValue(world.base);
    const result = await handlePush(world.deps, {
      repoName: world.session.forkRepo,
      ref: "refs/heads/work",
      before: "0".repeat(40),
      after: world.base,
    });
    expect(result).toMatchObject({ kind: "ignored" });
    expect((await rows(world)).changes).toHaveLength(0);
  });

  it("records a checkpoint pushed to the context repo", async () => {
    const world = await createWorld();
    const { git, capture } = world.ports;
    await git.createRepo(contextRepoName("app"));
    const ref = `${CHECKPOINT_REF_PREFIX}${CHECKPOINT.slice(-2)}/${CHECKPOINT}`;
    const push = git.push(contextRepoName("app"), ref, { "metadata.json": "{}" });

    expect(await handlePush(world.deps, push)).toEqual({
      kind: "checkpoint",
      checkpointId: CHECKPOINT,
    });
    expect(capture.checkpoints).toEqual([
      expect.objectContaining({
        repositoryId: world.repository.id,
        checkpointId: CHECKPOINT,
        tipSha: push.after,
      }),
    ]);
    expect(await handlePush(world.deps, { ...push, repoName: "ghost.context" })).toMatchObject({
      kind: "ignored",
    });
  });
});
