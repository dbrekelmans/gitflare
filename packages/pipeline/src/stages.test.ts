import type { StageHandler, StageInput, StageName, StageRun } from "@gitflare/core";
import { schema } from "@gitflare/db";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  findStageRun,
  handlePush,
  type PipelineDeps,
  queueStageRerun,
  recordStageOutcome,
  rerunStage,
  runStage,
  settleChange,
  stageAttempt,
  startStage,
} from "./index";
import { createWorld, findingOn, runStages, sectionPerFile, succeed, type World } from "./world";

async function opened(world: World) {
  const result = await handlePush(world.deps, world.push({ "src/b.ts": "export const b = 1;\n" }));
  if (result.kind !== "change") throw new Error("the push opened nothing");
  const input = (stage: StageName): StageInput & { stage: StageName } => {
    const run = result.stages.find((candidate) => candidate.stage === stage) as StageRun;
    const { changeId, revisionId, id: stageRunId, attempt } = run;
    return { changeId, revisionId, stageRunId, attempt, stage };
  };
  return { ...result, input };
}

const failing: StageHandler<unknown> = async () => {
  throw new Error("the model is unavailable");
};

function stageEvents(world: World, stage: StageName) {
  return world.ports.live.events.flatMap((event) =>
    event.type === "stage.status" && event.stage === stage ? [[event.attempt, event.status]] : [],
  );
}

describe("runStage", () => {
  it("records a stage from running to its outcome", async () => {
    const world = await createWorld();
    const { input } = await opened(world);
    let seen: StageRun | undefined;
    const handler: StageHandler<PipelineDeps> = async (deps, given) => {
      [seen] = await deps.db
        .select()
        .from(schema.stageRuns)
        .where(eq(schema.stageRuns.id, given.stageRunId));
      return { status: "succeeded" };
    };
    world.ports.clock.advance(1_000);
    const started = world.ports.clock.now();

    const run = await runStage(world.deps, handler, world.deps, input("intent"));

    expect(seen).toMatchObject({ status: "running", startedAt: started });
    expect(run).toMatchObject({ status: "succeeded", reason: null, finishedAt: started });
    expect(stageEvents(world, "intent")).toEqual([
      [1, "running"],
      [1, "succeeded"],
    ]);
  });

  it("records a skip with its reason, and a thrown error as a failure", async () => {
    const world = await createWorld();
    const { input } = await opened(world);
    const skipped = await runStage(
      world.deps,
      async () => ({ status: "skipped", reason: "Intent is derived once." }),
      null,
      input("intent"),
    );
    expect(skipped).toMatchObject({
      status: "skipped",
      reason: "Intent is derived once.",
      startedAt: null,
    });

    const failed = await runStage(world.deps, failing, null, input("review"));
    expect(failed).toMatchObject({ status: "failed", reason: "the model is unavailable" });
    expect(stageEvents(world, "review")).toEqual([
      [1, "running"],
      [1, "failed"],
    ]);
  });

  it("does not run a settled attempt again, and runs one left running", async () => {
    const world = await createWorld();
    const { input } = await opened(world);
    let calls = 0;
    const counting: StageHandler<unknown> = async () => {
      calls++;
      return { status: "succeeded" };
    };

    // A step that died after marking the attempt running is retried from the top.
    await startStage(world.deps, input("sections"));
    const first = await runStage(world.deps, counting, null, input("sections"));
    expect(calls).toBe(1);
    expect(first.status).toBe("succeeded");

    const again = await runStage(world.deps, failing, null, input("sections"));
    expect(again).toEqual(first);
    expect(stageEvents(world, "sections")).toEqual([
      [1, "running"],
      [1, "succeeded"],
    ]);
  });
});

describe("recordStageOutcome", () => {
  it("settles a stage whose work ran elsewhere, once", async () => {
    const world = await createWorld();
    const { input } = await opened(world);

    const run = await recordStageOutcome(world.deps, input("ci"), { status: "succeeded" });
    expect(run.status).toBe("succeeded");
    expect(run.startedAt).not.toBeNull();
    const late = await recordStageOutcome(world.deps, input("ci"), {
      status: "failed",
      reason: "reported twice",
    });
    expect(late).toEqual(run);
    expect(stageEvents(world, "ci")).toEqual([
      [1, "running"],
      [1, "succeeded"],
    ]);
  });

  it("skips a stage that never started", async () => {
    const world = await createWorld();
    const { input } = await opened(world);
    const run = await recordStageOutcome(world.deps, input("ci"), {
      status: "skipped",
      reason: "The repository has no CI file.",
    });
    expect(run).toMatchObject({ status: "skipped", startedAt: null });
    expect(stageEvents(world, "ci")).toEqual([[1, "skipped"]]);
  });
});

describe("settleChange", () => {
  it("keeps the change processing until the last stage settles", async () => {
    const world = await createWorld();
    const { changeId, input } = await opened(world);
    for (const stage of ["intent", "sections", "review"] as const) {
      await runStage(world.deps, succeed, null, input(stage));
      expect((await settleChange(world.deps, changeId)).status).toBe("processing");
    }
    world.ports.clock.advance(5_000);
    await runStage(world.deps, succeed, null, input("ci"));

    const change = await settleChange(world.deps, changeId);

    expect(change).toMatchObject({ status: "ready", readyAt: world.ports.clock.now() });
    expect(await world.change(changeId)).toEqual(change);
    const statuses = () =>
      world.ports.live.events.filter((event) => event.type === "change.status");
    expect(statuses().map((event) => event.status)).toEqual(["processing", "ready"]);
    // Settling again says nothing new.
    await settleChange(world.deps, changeId);
    expect(statuses()).toHaveLength(2);
  });

  it("leaves a change ready when a stage failed", async () => {
    const world = await createWorld();
    const result = await opened(world);

    await runStages(world, result, { sections: sectionPerFile, review: failing });

    const change = await world.change(result.changeId);
    expect(change.status).toBe("ready");
    expect(change.readyAt).not.toBeNull();
    const runs = await world.stageRuns(result.changeId);
    expect(runs.map((run) => [run.stage, run.status])).toEqual([
      ["intent", "succeeded"],
      ["sections", "succeeded"],
      ["review", "failed"],
      ["ci", "succeeded"],
    ]);
    expect(runs.find((run) => run.stage === "review")?.reason).toBe("the model is unavailable");
  });

  it("puts a finding in the section that presents its file", async () => {
    const world = await createWorld();
    const result = await opened(world);
    // Review finishes first, as it can: the two stages run in parallel.
    await runStage(world.deps, findingOn("src/b.ts"), world.deps, result.input("review"));
    await settleChange(world.deps, result.changeId);
    const threads = () => world.db.select().from(schema.threads);
    expect((await threads())[0]?.sectionId).toBeNull();

    await runStage(world.deps, sectionPerFile, world.deps, result.input("sections"));
    await settleChange(world.deps, result.changeId);

    const [section] = await world.db.select().from(schema.sections);
    expect(section?.title).toBe("src/b.ts");
    expect((await threads())[0]?.sectionId).toBe(section?.id);
  });

  it("skips the stages of a revision a later push replaced, and does not call the change ready for them", async () => {
    const world = await createWorld();
    const first = await opened(world);
    for (const stage of ["intent", "sections"] as const) {
      await runStage(world.deps, succeed, null, first.input(stage));
    }
    // Review is half way through when the next push arrives.
    await startStage(world.deps, first.input("review"));
    await handlePush(world.deps, world.push({ "src/b.ts": "export const b = 2;\n" }));

    let calls = 0;
    const counting: StageHandler<unknown> = async () => {
      calls++;
      return { status: "succeeded" };
    };
    const review = await runStage(world.deps, counting, null, first.input("review"));
    const ci = await startStage(world.deps, first.input("ci"));
    const change = await settleChange(world.deps, first.changeId);

    expect(calls).toBe(0);
    expect(review).toMatchObject({
      status: "skipped",
      reason: "A later push replaced this revision.",
    });
    expect(ci.status).toBe("skipped");
    expect(change.status).toBe("processing");
    expect(change.readyAt).toBeNull();
  });
});

describe("re-running a stage", () => {
  async function withFailedReview() {
    const world = await createWorld();
    const result = await opened(world);
    await runStages(world, result, { sections: sectionPerFile, review: failing });
    return { world, changeId: result.changeId };
  }

  it("queues a new attempt and returns the change to processing", async () => {
    const { world, changeId } = await withFailedReview();

    const rerun = await queueStageRerun(world.deps, changeId, "review");

    expect(rerun).toMatchObject({ stage: "review", attempt: 2, status: "queued" });
    expect((await world.change(changeId)).status).toBe("processing");
    expect(world.ports.live.events.slice(-2)).toEqual([
      expect.objectContaining({
        type: "stage.status",
        stage: "review",
        attempt: 2,
        status: "queued",
      }),
      expect.objectContaining({ type: "change.status", status: "processing" }),
    ]);
    // Asked twice, as a retried Workflow step would: still one new attempt.
    expect(await queueStageRerun(world.deps, changeId, "review")).toEqual(rerun);
    expect(await world.stageRuns(changeId)).toHaveLength(5);

    const { changeId: _c, revisionId, id: stageRunId, attempt, stage } = rerun;
    await runStage(world.deps, succeed, null, { changeId, revisionId, stageRunId, attempt, stage });
    expect((await settleChange(world.deps, changeId)).status).toBe("ready");
  });

  it("refuses while the stage is running", async () => {
    const world = await createWorld();
    const { changeId, input } = await opened(world);
    await startStage(world.deps, input("review"));
    await expect(queueStageRerun(world.deps, changeId, "review")).rejects.toMatchObject({
      code: "conflict",
    });
    await expect(rerunStage(world.deps, world.reviewer, changeId, "review")).rejects.toMatchObject({
      code: "conflict",
    });
    // Handed over all the same, which is what starts it again if its runner died.
    expect(world.ports.pipeline.reruns).toEqual([{ changeId, stage: "review", attempt: 1 }]);
    expect(await world.stageRuns(changeId)).toHaveLength(4);
  });

  it("finds the attempt a re-run names on the head revision, and nothing else", async () => {
    const { world, changeId } = await withFailedReview();
    const queued = await queueStageRerun(world.deps, changeId, "review");

    expect(await stageAttempt(world.deps, changeId, "review", 2)).toEqual(queued);
    expect(await stageAttempt(world.deps, changeId, "review", 3)).toBeNull();
    expect(await stageAttempt(world.deps, changeId, "intent", 2)).toBeNull();
    expect(await findStageRun(world.deps, queued.id)).toEqual(queued);
    expect(await findStageRun(world.deps, "stg_missing")).toBeNull();
    // Reading is all it does: still one queued attempt.
    expect(await world.stageRuns(changeId)).toHaveLength(5);
  });

  it("queues at once for a person and hands the run to the pipeline", async () => {
    const { world, changeId } = await withFailedReview();

    const run = await rerunStage(world.deps, world.reviewer, changeId, "review");

    expect(run).toMatchObject({ attempt: 2, status: "queued" });
    expect(world.ports.pipeline.reruns).toEqual([{ changeId, stage: "review", attempt: 2 }]);
  });
});
