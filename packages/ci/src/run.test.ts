import {
  CI_CONFIG_PATH,
  type CiStep,
  defaultOrganisationSettings,
  ForgeError,
  forkRepoName,
  type SandboxId,
  type StageInput,
} from "@gitflare/core";
import { workspaceStart } from "@gitflare/core/ports";
import { schema } from "@gitflare/db";
import { createTestDb } from "@gitflare/db/testing";
import { createFakePorts } from "@gitflare/testing";
import { describe, expect, it, vi } from "vitest";
import {
  CI_WORKDIR,
  type CiStart,
  finishCiRun,
  pollCiStep,
  readStepLog,
  startCiRun,
  startCiStep,
} from "./index";

const SNAPSHOT = { id: "snap_workspace", image: "cloudflare/debian-trixie" };

const PASSING = `setup: pnpm install --frozen-lockfile
instance: standard-1
steps:
  - name: lint
    run: pnpm lint
  - name: test
    run: pnpm test
    timeoutMinutes: 20
`;

// test fails; build and deploy hang off it; lint and docs do not.
const BRANCHING = `steps:
  - name: lint
    run: pnpm lint
  - name: test
    run: pnpm test
  - name: build
    run: pnpm build
    needs: [test]
  - name: deploy
    run: pnpm run deploy
    needs: [build, lint]
  - name: docs
    run: pnpm docs
    needs: [lint]
`;

/** One organisation, a repository, a session's fork with one pushed commit, and the CI attempt for it. */
async function createWorld(options: { ci?: string | null; prepared?: boolean } = {}) {
  const { ci = PASSING, prepared = true } = options;
  const db = createTestDb();
  const ports = createFakePorts();
  const { git, clock, ids } = ports;
  const deps = { ...ports, db };

  await db.insert(schema.organisations).values({
    id: "org_test",
    name: "Test",
    slug: "test",
    settings: {
      ...defaultOrganisationSettings,
      workspace: { image: SNAPSHOT.image, snapshot: prepared ? SNAPSHOT : null },
    },
    createdAt: clock.now(),
  });
  await git.createRepo("app");
  const base = git.push("app", "main", { "README.md": "hello\n" }).after;
  const repositoryId = ids.next("repository");
  await db.insert(schema.repositories).values({
    id: repositoryId,
    organisationId: "org_test",
    slug: "app",
    headSha: base,
    createdAt: clock.now(),
    readyAt: clock.now(),
  });
  const sessionId = ids.next("session");
  const forkRepo = forkRepoName("app", sessionId);
  await git.forkRepo("app", forkRepo);
  await db.insert(schema.sessions).values({
    id: sessionId,
    repositoryId,
    userId: "usr_ada",
    kind: "local",
    status: "active",
    title: "Add b",
    forkRepo,
    baseSha: base,
    createdAt: clock.now(),
    forkReadyAt: clock.now(),
  });
  const push = git.push(forkRepo, "work", {
    "src/b.ts": "export const b = 1;\n",
    ...(ci === null ? {} : { [CI_CONFIG_PATH]: ci }),
  });

  const input: StageInput = {
    changeId: ids.next("change"),
    revisionId: ids.next("revision"),
    stageRunId: ids.next("stageRun"),
    attempt: 1,
  };
  await db.insert(schema.changes).values({
    id: input.changeId,
    repositoryId,
    sessionId,
    number: 1,
    title: "Add b",
    status: "processing",
    authorId: "usr_ada",
    headRef: push.ref,
    baseSha: base,
    headSha: push.after,
    headRevisionId: input.revisionId,
    openedAt: clock.now(),
  });
  await db.insert(schema.revisions).values({
    id: input.revisionId,
    changeId: input.changeId,
    number: 1,
    baseSha: base,
    headSha: push.after,
    pushedAt: clock.now(),
    commits: 1,
    filesChanged: 1,
    insertions: 1,
    deletions: 0,
  });
  await db.insert(schema.stageRuns).values({
    id: input.stageRunId,
    changeId: input.changeId,
    revisionId: input.revisionId,
    stage: "ci",
    attempt: 1,
    status: "running",
  });

  const steps = async () =>
    (await db.select().from(schema.ciSteps).orderBy(schema.ciSteps.position)) as CiStep[];

  return {
    db,
    ports,
    deps,
    input,
    forkRepo,
    headSha: push.after,
    headRef: push.ref,
    runs: () => db.select().from(schema.ciRuns),
    steps,
    /** Each step as `[name, status, exit code]`, in the file's order. */
    results: async () => (await steps()).map((step) => [step.name, step.status, step.exitCode]),
    step: async (name: string) => {
      const found = (await steps()).find((step) => step.name === name);
      if (!found) throw new Error(`no step ${name}`);
      return found;
    },
    /** The commands the repository's file asked for, as the sandbox was given them. */
    ran: (kind: "exec" | "spawn") =>
      ports.sandboxes.commands
        .filter((command) => command.kind === kind)
        .map((command) => command.command.at(-1)),
    stepEvents: () =>
      ports.live.events.flatMap((event) =>
        event.type === "ci.step" ? [[event.name, event.status]] : [],
      ),
    logSignals: () =>
      ports.live.signals.flatMap(({ signal }) => (signal.type === "ci.log" ? [signal.text] : [])),
  };
}

type World = Awaited<ReturnType<typeof createWorld>>;

function sandboxId(start: CiStart): SandboxId {
  if (start.status !== "started") throw new Error("the run did not start");
  return `sbx_${start.run.id.slice("cir_".length)}`;
}

async function started(world: World) {
  const start = await startCiRun(world.deps, world.input);
  if (start.status !== "started") throw new Error("the run did not start");
  const id = sandboxId(start);
  return { ...start, sandboxId: id, sandbox: world.ports.sandboxes.get(id) };
}

/** What the Workflow does: wave by wave, start every step and poll it until it settles. */
async function runWaves(world: World, start: Extract<CiStart, { status: "started" }>) {
  for (const wave of start.waves) {
    await Promise.all(
      wave.map(async (name) => {
        let step = await startCiStep(world.deps, start.run.id, name);
        while (step.status === "running") step = await pollCiStep(world.deps, step.id);
      }),
    );
  }
}

async function messageOf(work: Promise<unknown>): Promise<string> {
  const error = await work.then(
    () => null,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(ForgeError);
  return (error as ForgeError).message;
}

describe("a passing run", () => {
  it("records green steps and a succeeded run", async () => {
    const world = await createWorld();
    world.ports.sandboxes.onCommand("pnpm test", { stdout: "3 passed\n" });

    const start = await started(world);
    expect(start.waves).toEqual([["lint", "test"]]);
    const { changeId, revisionId } = world.input;
    expect(start.run).toEqual({
      id: start.run.id,
      changeId,
      revisionId,
      status: "running",
      reason: null,
      startedAt: world.ports.clock.now(),
      finishedAt: null,
    });
    await runWaves(world, start);
    world.ports.clock.advance(5_000);
    const outcome = await finishCiRun(world.deps, start.run.id);

    expect(outcome).toEqual({ status: "succeeded" });
    expect(await world.results()).toEqual([
      ["lint", "succeeded", 0],
      ["test", "succeeded", 0],
    ]);
    expect(await world.step("test")).toMatchObject({ command: "pnpm test", logTail: "3 passed\n" });
    expect(await world.runs()).toMatchObject([
      { status: "succeeded", finishedAt: world.ports.clock.now() },
    ]);
    expect(world.stepEvents()).toEqual(
      expect.arrayContaining([
        ["lint", "running"],
        ["lint", "succeeded"],
        ["test", "running"],
        ["test", "succeeded"],
      ]),
    );
    expect(world.stepEvents()).toHaveLength(4);
    expect(await start.sandbox.isRunning()).toBe(false);
  });

  it("boots the prepared workspace with access to the fork and the registry only", async () => {
    const world = await createWorld();

    const start = await started(world);

    const options = world.ports.sandboxes.startOptions(start.sandboxId);
    expect(options).toEqual({
      ...workspaceStart({ image: SNAPSHOT.image, snapshot: SNAPSHOT }),
      instance: "standard-1",
      egress: [
        { kind: "git", repo: world.forkRepo, scope: "read" },
        { kind: "host", host: "registry.npmjs.org" },
      ],
    });
    // `*` is open Internet with nothing intercepted.
    expect(options?.egress.some((grant) => grant.kind === "host" && grant.host === "*")).toBe(
      false,
    );
  });

  it("checks out the revision's commit, then runs setup and each step in the checkout", async () => {
    const world = await createWorld();

    const start = await started(world);
    await runWaves(world, start);

    const { commands } = world.ports.sandboxes;
    const remote = (await world.ports.git.getRepo(world.forkRepo))?.remote;
    expect(commands[0]).toMatchObject({ kind: "exec" });
    expect(commands[0]?.command.slice(-4)).toEqual([
      CI_WORKDIR,
      remote,
      world.headSha,
      world.headRef,
    ]);
    expect(world.ran("spawn")).toEqual([
      "pnpm install --frozen-lockfile",
      "pnpm lint",
      "pnpm test",
    ]);
    const spawned = commands.filter((command) => command.kind === "spawn");
    expect(spawned.map((command) => command.options.cwd)).toEqual(Array(3).fill(CI_WORKDIR));
    expect(spawned.map((command) => command.options.timeoutSeconds)).toEqual([900, 900, 1200]);
  });
});

describe("a failing step", () => {
  it("fails the run and skips its dependants, and nothing else", async () => {
    const world = await createWorld({ ci: BRANCHING });
    world.ports.sandboxes.onCommand("pnpm test", { exitCode: 1, stdout: "1 failed\n" });

    const start = await started(world);
    await runWaves(world, start);
    const outcome = await finishCiRun(world.deps, start.run.id);

    expect(outcome).toEqual({ status: "failed", reason: "Step test failed with exit code 1." });
    expect(await world.results()).toEqual([
      ["lint", "succeeded", 0],
      ["test", "failed", 1],
      ["build", "cancelled", null],
      ["deploy", "cancelled", null],
      ["docs", "succeeded", 0],
    ]);
    // A skipped step's command never reaches the sandbox.
    expect(world.ran("spawn")).toEqual(["pnpm lint", "pnpm test", "pnpm docs"]);
    expect((await world.step("build")).logTail).toContain("test did not succeed");
    expect((await world.step("deploy")).logTail).toContain("build did not succeed");
    expect((await world.step("test")).logTail).toBe("1 failed\n");
    expect(await world.runs()).toMatchObject([{ status: "failed" }]);
    expect(world.stepEvents()).toEqual(
      expect.arrayContaining([
        ["test", "failed"],
        ["build", "cancelled"],
        ["deploy", "cancelled"],
      ]),
    );
  });

  it("says why a step that ran out of time stopped", async () => {
    const world = await createWorld();
    world.ports.sandboxes.onCommand("pnpm test", { exitCode: 124, stdout: "still going\n" });

    const start = await started(world);
    await runWaves(world, start);

    expect(await world.step("test")).toMatchObject({ status: "failed", exitCode: 124 });
    expect((await world.step("test")).logTail).toBe(
      "still going\n[gitflare] Exit code 124: the step ran out of time.\n",
    );
  });

  it("refuses to start a step before what it needs has finished", async () => {
    const world = await createWorld({ ci: BRANCHING });
    const start = await started(world);

    const message = await messageOf(startCiStep(world.deps, start.run.id, "build"));

    expect(message).toBe("build needs test, which has not finished.");
    expect(await world.step("build")).toMatchObject({ status: "queued" });
  });
});

describe("a run that cannot start", () => {
  it("skips the stage when the commit has no CI file", async () => {
    const world = await createWorld({ ci: null });

    const start = await startCiRun(world.deps, world.input);

    expect(start).toEqual({
      status: "skipped",
      reason: "The repository has no .gitflare/ci.yml at this commit.",
    });
    expect(await world.runs()).toEqual([]);
    expect(world.ports.sandboxes.commands).toEqual([]);
  });

  it("fails with the reason from workspaceStart when the workspace is not prepared", async () => {
    const world = await createWorld({ prepared: false });
    let reason = "";
    try {
      workspaceStart({ image: SNAPSHOT.image, snapshot: null });
    } catch (error) {
      reason = (error as Error).message;
    }

    const message = await messageOf(startCiRun(world.deps, world.input));

    expect(reason).not.toBe("");
    expect(message).toBe(reason);
    expect(await world.runs()).toEqual([]);
    expect(world.ports.sandboxes.commands).toEqual([]);
  });

  it("refuses a CI file it cannot read, and records nothing", async () => {
    const world = await createWorld({ ci: "steps:\n  - name: a\n    run: x\n    needs: [b]\n" });

    const message = await messageOf(startCiRun(world.deps, world.input));

    expect(message).toContain("a needs b, which is not a step");
    expect(await world.runs()).toEqual([]);
  });

  it("closes the run with the setup command's output when setup fails", async () => {
    const world = await createWorld();
    world.ports.sandboxes.onCommand("pnpm install", {
      exitCode: 1,
      stdout: "ERR_PNPM_OUTDATED_LOCKFILE\n",
    });

    const message = await messageOf(startCiRun(world.deps, world.input));

    expect(message).toBe("The setup command failed (exit code 1): ERR_PNPM_OUTDATED_LOCKFILE");
    const [run] = await world.runs();
    expect(run).toMatchObject({ status: "failed" });
    expect(await world.results()).toEqual([
      ["lint", "cancelled", null],
      ["test", "cancelled", null],
    ]);
    expect(await world.ports.sandboxes.get(`sbx_${run?.id.slice(4)}`).isRunning()).toBe(false);
  });

  it("closes the run when the commit cannot be checked out", async () => {
    const world = await createWorld();
    world.ports.sandboxes.onCommand("gitflare-checkout", {
      exitCode: 128,
      stderr: "fatal: couldn't find remote ref\n",
    });

    const message = await messageOf(startCiRun(world.deps, world.input));

    expect(message).toBe(
      "CI could not check the commit out (exit code 128): fatal: couldn't find remote ref",
    );
    expect(await world.runs()).toMatchObject([{ status: "failed" }]);
    expect(world.ran("spawn")).toEqual([]);
  });
});

describe("calling a function twice", () => {
  it("startCiRun returns the same run and touches the sandbox once", async () => {
    const world = await createWorld();

    const first = await started(world);
    const commands = world.ports.sandboxes.commands.length;
    world.ports.clock.advance(1_000);
    const second = await startCiRun(world.deps, world.input);

    expect(second).toEqual({ status: "started", run: first.run, waves: first.waves });
    expect(await world.runs()).toHaveLength(1);
    expect(await world.steps()).toHaveLength(2);
    expect(world.ports.sandboxes.commands).toHaveLength(commands);
  });

  it("startCiRun picks up a start that died half way", async () => {
    const world = await createWorld();
    let crashes = 1;
    world.ports.sandboxes.on((command) => {
      if (command.command.includes("gitflare-checkout") && crashes-- > 0) {
        throw new Error("Network connection lost.");
      }
      return undefined;
    });

    await expect(startCiRun(world.deps, world.input)).rejects.toThrow("Network connection lost.");
    // Not a refusal: the run is left as it was for the retry.
    expect(await world.runs()).toMatchObject([{ status: "queued" }]);
    const start = await started(world);

    // The fake refuses to start a running sandbox: the second call did not try.
    expect(await world.runs()).toMatchObject([{ id: start.run.id, status: "running" }]);
    expect(await world.steps()).toHaveLength(2);
    expect(world.ran("spawn")).toEqual(["pnpm install --frozen-lockfile"]);
  });

  it("startCiRun does not run setup again over a second checkout", async () => {
    const world = await createWorld();
    const first = startCiRun(world.deps, world.input);
    // Dies after setup was started: the write that marks the run as running is the first update.
    const update = vi.spyOn(world.deps.db, "update").mockImplementationOnce(() => {
      throw new Error("D1 is unavailable");
    });
    await expect(first).rejects.toThrow("D1 is unavailable");
    update.mockRestore();
    expect(world.ran("spawn")).toEqual(["pnpm install --frozen-lockfile"]);

    const start = await started(world);

    expect(start.run.status).toBe("running");
    expect(world.ran("exec")).toHaveLength(1);
    expect(world.ran("spawn")).toEqual(["pnpm install --frozen-lockfile"]);
  });

  it("startCiStep starts the command once and announces it once", async () => {
    const world = await createWorld();
    const start = await started(world);

    const first = await startCiStep(world.deps, start.run.id, "lint");
    world.ports.clock.advance(1_000);
    const second = await startCiStep(world.deps, start.run.id, "lint");

    expect(first.status).toBe("running");
    expect(second).toEqual(first);
    expect(world.ran("spawn").filter((command) => command === "pnpm lint")).toHaveLength(1);
    expect(world.stepEvents()).toEqual([["lint", "running"]]);
  });

  it("startCiStep adopts a command that was started before the crash", async () => {
    const world = await createWorld();
    const start = await started(world);
    await start.sandbox.spawn("step-lint", ["pnpm", "lint"]);
    const spawns = world.ran("spawn").length;

    const step = await startCiStep(world.deps, start.run.id, "lint");

    expect(step.status).toBe("running");
    expect(world.ran("spawn")).toHaveLength(spawns);
  });

  it("pollCiStep records the result once and forwards each line once", async () => {
    const world = await createWorld();
    world.ports.sandboxes.onCommand("pnpm test", { exitCode: 2, stdout: "1 failed\n" });
    const start = await started(world);
    const { id } = await startCiStep(world.deps, start.run.id, "test");

    const first = await pollCiStep(world.deps, id);
    world.ports.clock.advance(1_000);
    const second = await pollCiStep(world.deps, id);

    expect(first).toMatchObject({ status: "failed", exitCode: 2, logTail: "1 failed\n" });
    expect(second).toEqual(first);
    expect(world.logSignals()).toEqual(["1 failed\n"]);
    expect(world.stepEvents()).toEqual([
      ["test", "running"],
      ["test", "failed"],
    ]);
  });

  it("finishCiRun gives the same answer and leaves the record alone", async () => {
    const world = await createWorld({ ci: BRANCHING });
    world.ports.sandboxes.onCommand("pnpm test", { exitCode: 1 });
    const start = await started(world);
    await runWaves(world, start);

    const first = await finishCiRun(world.deps, start.run.id);
    const [run] = await world.runs();
    const events = world.stepEvents().length;
    world.ports.clock.advance(1_000);
    const second = await finishCiRun(world.deps, start.run.id);

    expect(second).toEqual(first);
    expect(await world.runs()).toEqual([run]);
    expect(world.stepEvents()).toHaveLength(events);
  });
});

describe("output", () => {
  it("is forwarded as it is written, and only what is new", async () => {
    const world = await createWorld();
    const start = await started(world);
    const { id } = await startCiStep(world.deps, start.run.id, "test");
    const status = vi.spyOn(start.sandbox, "processStatus");
    const log = vi.spyOn(start.sandbox, "readLog");
    const written = (text: string) =>
      log.mockImplementation(async (_name, _stream, offset) => ({
        text: text.slice(offset),
        nextOffset: text.length,
      }));

    status.mockResolvedValue({ state: "running" });
    written("one\n");
    expect(await pollCiStep(world.deps, id)).toMatchObject({ status: "running", logTail: "one\n" });
    // Nothing new: nothing is sent.
    await pollCiStep(world.deps, id);
    written("one\ntwo\n");
    await pollCiStep(world.deps, id);
    status.mockResolvedValue({ state: "exited", exitCode: 0 });
    written("one\ntwo\nthree\n");
    const done = await pollCiStep(world.deps, id);

    expect(world.logSignals()).toEqual(["one\n", "two\n", "three\n"]);
    expect(world.ports.live.signals[0]).toMatchObject({
      changeId: world.input.changeId,
      signal: { stepId: id },
    });
    expect(done).toMatchObject({ status: "succeeded", logTail: "one\ntwo\nthree\n" });
    expect((await world.step("test")).logTail).toBe("one\ntwo\nthree\n");
  });

  it("is read whole while the sandbox is alive, and from the stored tail afterwards", async () => {
    const world = await createWorld();
    const long = `${"x".repeat(79)}\n`.repeat(200);
    world.ports.sandboxes.onCommand("pnpm test", { stdout: long });
    world.ports.sandboxes.onCommand("pnpm lint", { stdout: "clean\n" });
    const start = await started(world);
    await runWaves(world, start);
    const test = await world.step("test");
    const lint = await world.step("lint");

    expect(await readStepLog(world.deps, test.id)).toEqual({ text: long, complete: true });

    await finishCiRun(world.deps, start.run.id);

    expect(test.logTail).toBe(long.slice(-8_000));
    expect(await readStepLog(world.deps, test.id)).toEqual({ text: test.logTail, complete: false });
    // A log that fitted in the tail is still all there.
    expect(await readStepLog(world.deps, lint.id)).toEqual({ text: "clean\n", complete: true });
  });

  it("of a step that was skipped is the reason, without asking the sandbox", async () => {
    const world = await createWorld({ ci: BRANCHING });
    world.ports.sandboxes.onCommand("pnpm test", { exitCode: 1 });
    const start = await started(world);
    await runWaves(world, start);
    const build = await world.step("build");

    expect(await readStepLog(world.deps, build.id)).toEqual({
      text: "[gitflare] Not run: test did not succeed.\n",
      complete: true,
    });
  });
});

describe("a sandbox that stops under a run", () => {
  /** What `SandboxController` does once its container is gone; the fake answers as if nothing ran. */
  function stopLikeTheRealOne(sandbox: Awaited<ReturnType<typeof started>>["sandbox"]) {
    const gone = new ForgeError("unavailable", "The sandbox is not running.");
    vi.spyOn(sandbox, "isRunning").mockResolvedValue(false);
    vi.spyOn(sandbox, "processStatus").mockRejectedValue(gone);
    vi.spyOn(sandbox, "readLog").mockRejectedValue(gone);
    vi.spyOn(sandbox, "spawn").mockRejectedValue(gone);
  }

  it.each([
    ["as the real controller reports it", stopLikeTheRealOne],
    ["as the fake reports it", (sandbox: { stop(): Promise<void> }) => sandbox.stop()],
  ])("fails the step that was running, %s", async (_how, stop) => {
    const world = await createWorld({ ci: BRANCHING });
    const start = await started(world);
    const lint = await startCiStep(world.deps, start.run.id, "lint");
    const test = await startCiStep(world.deps, start.run.id, "test");
    await pollCiStep(world.deps, lint.id);

    await stop(start.sandbox);
    const polled = await pollCiStep(world.deps, test.id);
    // A step whose needs succeeded, started after the sandbox was gone.
    const docs = await startCiStep(world.deps, start.run.id, "docs");
    const outcome = await finishCiRun(world.deps, start.run.id);

    expect(polled).toMatchObject({ status: "failed", exitCode: null });
    expect(polled.logTail).toContain("The sandbox stopped before this step finished.");
    expect(docs).toMatchObject({ status: "failed", exitCode: null });
    expect(docs.logTail).toContain("The sandbox stopped before this step could start.");
    expect(outcome).toEqual({
      status: "failed",
      reason:
        "Step test did not finish: the sandbox stopped or could not run it, and 1 more failed.",
    });
    expect(await world.results()).toEqual([
      ["lint", "succeeded", 0],
      ["test", "failed", null],
      ["build", "cancelled", null],
      ["deploy", "cancelled", null],
      ["docs", "failed", null],
    ]);
    expect(await readStepLog(world.deps, test.id)).toEqual({
      text: polled.logTail,
      complete: true,
    });
  });

  it("does not call a killed step a test failure when the container died with it", async () => {
    const world = await createWorld();
    world.ports.sandboxes.onCommand("pnpm test", { exitCode: 137, stdout: "Killed\n" });
    const start = await started(world);
    const { id } = await startCiStep(world.deps, start.run.id, "test");
    vi.spyOn(start.sandbox, "isRunning").mockResolvedValue(false);

    const step = await pollCiStep(world.deps, id);

    expect(step).toMatchObject({ status: "failed", exitCode: null });
    expect(step.logTail).toBe(
      "Killed\n[gitflare] The sandbox stopped before this step finished.\n",
    );
  });

  it("keeps a killed step's exit code when the sandbox is still up", async () => {
    const world = await createWorld();
    world.ports.sandboxes.onCommand("pnpm test", { exitCode: 137, stdout: "Killed\n" });
    const start = await started(world);
    const { id } = await startCiStep(world.deps, start.run.id, "test");

    const step = await pollCiStep(world.deps, id);

    expect(step).toMatchObject({ status: "failed", exitCode: 137 });
    expect(step.logTail).toContain("Exit code 137");
  });

  it("leaves a step running when the sandbox is up but could not be asked", async () => {
    const world = await createWorld();
    const start = await started(world);
    const { id } = await startCiStep(world.deps, start.run.id, "test");
    vi.spyOn(start.sandbox, "processStatus").mockRejectedValueOnce(
      new ForgeError("unavailable", "The sandbox was lost: Network connection lost."),
    );

    await expect(pollCiStep(world.deps, id)).rejects.toThrow("Network connection lost.");

    expect(await world.step("test")).toMatchObject({ status: "running" });
    expect(await pollCiStep(world.deps, id)).toMatchObject({ status: "succeeded" });
  });

  it("fails one step, not the run, when a live sandbox refuses to launch it", async () => {
    const world = await createWorld();
    const start = await started(world);
    vi.spyOn(start.sandbox, "spawn").mockRejectedValueOnce(
      new ForgeError("unavailable", "The sandbox was lost: no such file or directory"),
    );

    const lint = await startCiStep(world.deps, start.run.id, "lint");
    const test = await startCiStep(world.deps, start.run.id, "test");

    expect(lint).toMatchObject({ status: "failed", exitCode: null });
    expect(lint.logTail).toBe(
      "[gitflare] The step could not be started: The sandbox was lost: no such file or directory\n",
    );
    expect(test.status).toBe("running");
  });

  it("cancels what never ran when the run is finished early", async () => {
    const world = await createWorld();
    const start = await started(world);
    await startCiStep(world.deps, start.run.id, "lint");

    const outcome = await finishCiRun(world.deps, start.run.id);

    expect(outcome).toEqual({ status: "failed", reason: "CI stopped before every step had run." });
    expect(await world.results()).toEqual([
      ["lint", "cancelled", null],
      ["test", "cancelled", null],
    ]);
    expect(await start.sandbox.isRunning()).toBe(false);
  });
});
