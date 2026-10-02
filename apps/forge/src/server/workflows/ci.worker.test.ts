/// <reference types="@cloudflare/vitest-plugin/types" />
import { introspectWorkflow } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  CI_CONFIG_PATH,
  type CiFinishedPayload,
  defaultOrganisationSettings,
  forkRepoName,
  type Session,
  type StageHandler,
} from "@gitflare/core";
import { createIdGenerator } from "@gitflare/core/ports";
import { schema } from "@gitflare/db";
import { createD1Db } from "@gitflare/db/d1";
import { createFakePorts } from "@gitflare/testing";
import { and, eq } from "drizzle-orm";
import { afterEach, expect, it } from "vitest";
import { ensureDevDatabase } from "../dev";
import type { Services } from "../services";
import { pipelineRuntime } from "./change-pipeline";
import { ciRuntime, notifyPipeline } from "./ci";

// The real CI Workflow in workerd, with local D1, on fake ports. It is started
// the way production starts it, by the real pipeline Workflow, which then
// waits for `CI_FINISHED_EVENT`: the CI stage only settles if that event was
// really sent, and settles with exactly what it carried.

const production = { pipeline: pipelineRuntime.create, ci: ciRuntime.create };
afterEach(() => {
  pipelineRuntime.create = production.pipeline;
  ciRuntime.create = production.ci;
});

const CI_FILE = `setup: pnpm install
steps:
  - name: lint
    run: pnpm lint
  - name: test
    run: pnpm test
  - name: build
    run: pnpm build
    needs: [test]
`;

const succeed: StageHandler<unknown> = async () => ({ status: "succeeded" });
const SNAPSHOT = { id: "snap_workspace", image: defaultOrganisationSettings.workspace.image };

let repositories = 0;

/** A repository and a session's fork, in local D1 and a fake git host, and both Workflows pointed at them. */
async function world(options: { prepared?: boolean } = {}) {
  const ports = createFakePorts();
  const { git, clock } = ports;
  const ids = createIdGenerator();
  const db = createD1Db(env.DB);
  const services: Services = { ...ports, ids, db, mode: "dev" };
  await ensureDevDatabase(services, env.DB);
  const workspace = { ...SNAPSHOT, snapshot: options.prepared === false ? null : SNAPSHOT };
  await db
    .update(schema.organisations)
    .set({ settings: { ...defaultOrganisationSettings, workspace } })
    .where(eq(schema.organisations.id, "org_northwind"));

  const slug = `ci-${++repositories}`;
  await git.createRepo(slug);
  const base = git.push(slug, "main", { "README.md": "hello\n" }).after;
  const repositoryId = ids.next("repository");
  await db.insert(schema.repositories).values({
    id: repositoryId,
    organisationId: "org_northwind",
    slug,
    headSha: base,
    createdAt: clock.now(),
    readyAt: clock.now(),
  });
  const sessionId = ids.next("session");
  const session: Session = {
    id: sessionId,
    repositoryId,
    userId: "usr_jonas",
    kind: "local",
    status: "active",
    title: "Add b",
    forkRepo: forkRepoName(slug, sessionId),
    baseSha: base,
    createdAt: clock.now(),
    forkReadyAt: clock.now(),
    endedAt: null,
    forkDeletedAt: null,
  };
  await git.forkRepo(slug, session.forkRepo);
  await db.insert(schema.sessions).values(session);

  const sent: { instanceId: string; outcome: CiFinishedPayload }[] = [];
  pipelineRuntime.create = () => ({
    services,
    stages: { intent: succeed, sections: succeed, review: succeed },
    // As production does it: the real CI Workflow, one instance per attempt.
    startCi: async (bindings, params) => {
      await bindings.CI.create({ id: params.stageRunId, params });
    },
  });
  ciRuntime.create = () => ({
    services,
    notify: async (bindings, instanceId, outcome) => {
      sent.push({ instanceId, outcome });
      await notifyPipeline(bindings, instanceId, outcome);
    },
  });

  /** Pushes one commit to the session's branch and waits for the pipeline and the CI run to end. */
  async function push(files: Record<string, string>) {
    await using pipelines = await introspectWorkflow(env.CHANGE_PIPELINE);
    await using runs = await introspectWorkflow(env.CI);
    await pipelines.modifyAll((modifier) => modifier.disableSleeps());
    await runs.modifyAll(async (modifier) => {
      await modifier.disableSleeps();
      await modifier.disableRetryDelays();
    });
    const params = { kind: "push" as const, push: git.push(session.forkRepo, "work", files) };
    await env.CHANGE_PIPELINE.create({ params });
    let waited = 0;
    for (let instances = await pipelines.get(); waited < instances.length; ) {
      for (const instance of instances.slice(waited)) await instance.waitForStatus("complete");
      waited = instances.length;
      instances = await pipelines.get();
    }
    const ci = await runs.get();
    for (const instance of ci) await instance.waitForStatus("complete");

    const [change] = await db
      .select()
      .from(schema.changes)
      .where(eq(schema.changes.sessionId, session.id));
    if (!change) throw new Error("the push opened no change");
    const [stage] = await db
      .select()
      .from(schema.stageRuns)
      .where(and(eq(schema.stageRuns.changeId, change.id), eq(schema.stageRuns.stage, "ci")));
    const [run] = await db
      .select()
      .from(schema.ciRuns)
      .where(eq(schema.ciRuns.changeId, change.id));
    const steps = run
      ? await db
          .select()
          .from(schema.ciSteps)
          .where(eq(schema.ciSteps.runId, run.id))
          .orderBy(schema.ciSteps.position)
      : [];
    return {
      change,
      stage,
      run,
      steps: steps.map((step) => [step.name, step.status, step.exitCode]),
      instances: ci.length,
    };
  }

  return { ports, sent, push };
}

it("runs to completion and sends CI_FINISHED_EVENT, which settles the pipeline's CI stage", async () => {
  const { ports, sent, push } = await world();
  // Each step is still running the first time it is asked about, so the Workflow sleeps and asks again.
  const stillRunning = new Set<string>();
  const get = ports.sandboxes.get.bind(ports.sandboxes);
  ports.sandboxes.get = (id) => {
    const sandbox = get(id);
    const processStatus = sandbox.processStatus.bind(sandbox);
    sandbox.processStatus = async (name) => {
      const status = await processStatus(name);
      if (!status || !name.startsWith("step-") || stillRunning.has(name)) return status;
      stillRunning.add(name);
      return { state: "running" };
    };
    ports.sandboxes.get = get;
    return sandbox;
  };

  const { change, stage, run, steps, instances } = await push({
    [CI_CONFIG_PATH]: CI_FILE,
    "src/b.ts": "export const b = 1;\n",
  });

  expect(instances).toBe(1);
  expect(sent).toHaveLength(1);
  expect(sent[0]?.outcome).toEqual({ status: "succeeded" });
  // The pipeline instance got the event: nothing else moves this stage on.
  expect(stage).toMatchObject({ status: "succeeded", reason: null });
  expect(change.status).toBe("ready");
  expect(run).toMatchObject({ status: "succeeded", stageRunId: stage?.id });
  expect(steps).toEqual([
    ["lint", "succeeded", 0],
    ["test", "succeeded", 0],
    ["build", "succeeded", 0],
  ]);
  expect([...stillRunning].sort()).toEqual(["step-build", "step-lint", "step-test"]);
  expect(ports.sandboxes.commands.map((command) => command.command.at(-1))).toEqual(
    expect.arrayContaining(["pnpm install", "pnpm lint", "pnpm test", "pnpm build"]),
  );
});

it("reports a failing step, with its dependants skipped", async () => {
  const { ports, sent, push } = await world();
  ports.sandboxes.onCommand("pnpm test", { exitCode: 1, stdout: "1 failed\n" });

  const { stage, run, steps } = await push({ [CI_CONFIG_PATH]: CI_FILE });

  const failed = { status: "failed", reason: "Step test failed with exit code 1." };
  expect(sent.map((event) => event.outcome)).toEqual([failed]);
  expect(stage).toMatchObject(failed);
  expect(run).toMatchObject({ status: "failed" });
  expect(steps).toEqual([
    ["lint", "succeeded", 0],
    ["test", "failed", 1],
    ["build", "cancelled", null],
  ]);
});

it("reports the stage as skipped for a repository with no CI file", async () => {
  const { ports, sent, push } = await world();

  const { stage, run } = await push({ "src/b.ts": "b\n" });

  const reason = "The repository has no .gitflare/ci.yml at this commit.";
  expect(sent.map((event) => event.outcome)).toEqual([{ status: "skipped", reason }]);
  expect(stage).toMatchObject({ status: "skipped", reason });
  expect(run).toBeUndefined();
  expect(ports.sandboxes.commands).toEqual([]);
});

it("reports why CI could not start when the workspace is not prepared", async () => {
  const { sent, push } = await world({ prepared: false });

  const { stage, run } = await push({ [CI_CONFIG_PATH]: CI_FILE });

  expect(sent).toHaveLength(1);
  expect(stage).toMatchObject({
    status: "failed",
    reason: "The workspace has not been prepared yet. An administrator can prepare it in Settings.",
  });
  expect(run).toBeUndefined();
});

it("closes the run and still reports when a step keeps throwing", async () => {
  const { ports, sent, push } = await world();
  ports.sandboxes.on((command) => {
    if (command.command.at(-1) === "pnpm test") throw new Error("the sandbox did not answer");
    return undefined;
  });

  const { stage, run, steps } = await push({ [CI_CONFIG_PATH]: CI_FILE });

  expect(sent).toHaveLength(1);
  expect(stage?.status).toBe("failed");
  expect(stage?.reason).toContain("CI could not finish:");
  expect(stage?.reason).toContain("the sandbox did not answer");
  expect(run).toMatchObject({ status: "failed" });
  // lint was seen to its end before the run was closed.
  expect(steps).toEqual([
    ["lint", "succeeded", 0],
    ["test", "cancelled", null],
    ["build", "cancelled", null],
  ]);
});
