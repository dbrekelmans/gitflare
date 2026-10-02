/// <reference types="@cloudflare/vitest-plugin/types" />
import { introspectWorkflow } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  ARTIFACTS_PUSH_EVENT,
  type ChangeId,
  CI_FINISHED_EVENT,
  type CiFinishedPayload,
  forkRepoName,
  type PipelineParams,
  type Session,
  type StageHandler,
  type StageName,
} from "@gitflare/core";
import { createIdGenerator } from "@gitflare/core/ports";
import { changeEventsAfter, schema } from "@gitflare/db";
import { createD1Db } from "@gitflare/db/d1";
import { createFakePorts } from "@gitflare/testing";
import { eq } from "drizzle-orm";
import { afterEach, expect, it, vi } from "vitest";
import { ensureDevDatabase } from "../dev";
import type { Services } from "../services";
import { type PipelineRuntime, pipelineRuntime } from "./change-pipeline";

// The real Workflow in workerd, with local D1, on fake ports and fake stages.

const production = pipelineRuntime.create;
afterEach(() => {
  pipelineRuntime.create = production;
});

const succeed: StageHandler<unknown> = async () => ({ status: "succeeded" });
const fail: StageHandler<unknown> = async () => {
  throw new Error("the model is unavailable");
};

let repositories = 0;

/** A repository, a session and its fork, in local D1 and a fake git host, and the Workflow pointed at them. */
async function world(ci: CiFinishedPayload | null = { status: "succeeded" }) {
  const ports = createFakePorts();
  const { git, clock } = ports;
  const ids = createIdGenerator();
  const db = createD1Db(env.DB);
  const services: Services = { ...ports, ids, db, mode: "dev" };
  await ensureDevDatabase(services, env.DB);

  const slug = `pipeline-${++repositories}`;
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

  const calls: StageName[] = [];
  const counted =
    (stage: StageName, handler: StageHandler<unknown>): StageHandler<unknown> =>
    async (deps, input) => {
      calls.push(stage);
      return handler(deps, input);
    };
  const runtime: PipelineRuntime = {
    services,
    stages: {
      intent: counted("intent", succeed),
      sections: counted("sections", succeed),
      review: counted("review", fail),
    },
    // A CI Workflow that finishes at once, or never reports.
    async startCi(bindings, params) {
      calls.push("ci");
      if (!ci) return;
      const pipeline = await bindings.CHANGE_PIPELINE.get(params.notifyInstanceId);
      await pipeline.sendEvent({ type: CI_FINISHED_EVENT, payload: ci });
    },
  };
  pipelineRuntime.create = () => runtime;

  /**
   * Starts one instance per delivery, all at once, and waits for them and for
   * every instance they start in turn, with sleeps skipped.
   */
  async function run(
    deliveries: PipelineParams | PipelineParams[],
    options: { ciTimesOut?: boolean } = {},
  ) {
    await using introspector = await introspectWorkflow(env.CHANGE_PIPELINE);
    await introspector.modifyAll(async (modifier) => {
      await modifier.disableSleeps();
      if (options.ciTimesOut) await modifier.forceEventTimeout({ name: "wait for ci" });
    });
    await Promise.all([deliveries].flat().map((params) => env.CHANGE_PIPELINE.create({ params })));
    let waited = 0;
    for (let instances = await introspector.get(); waited < instances.length; ) {
      for (const instance of instances.slice(waited)) await instance.waitForStatus("complete");
      waited = instances.length;
      instances = await introspector.get();
    }
    return waited;
  }

  return {
    db,
    ports,
    runtime,
    slug,
    session,
    calls,
    run,
    push: (files: Record<string, string>, message = "Work") =>
      git.push(session.forkRepo, "work", files, { message }),
    change: async () => {
      const [change] = await db
        .select()
        .from(schema.changes)
        .where(eq(schema.changes.sessionId, session.id));
      if (!change) throw new Error("the session has no change");
      return change;
    },
    stages: async (changeId: ChangeId) =>
      (await db.select().from(schema.stageRuns).where(eq(schema.stageRuns.changeId, changeId)))
        .sort((a, b) => a.attempt - b.attempt)
        .map((run) => [run.stage, run.attempt, run.status, run.reason]),
  };
}

it("takes a push to a ready change, through every stage, a failing one included", async () => {
  const { run, push, change, stages, calls, db } = await world();

  await run({ kind: "push", push: push({ "src/b.ts": "export const b = 1;\n" }) });

  const opened = await change();
  expect(opened).toMatchObject({ number: 1, status: "ready", title: "Add b" });
  expect(opened.readyAt).not.toBeNull();
  expect(await stages(opened.id)).toEqual([
    ["intent", 1, "succeeded", null],
    ["sections", 1, "succeeded", null],
    ["review", 1, "failed", "the model is unavailable"],
    ["ci", 1, "succeeded", null],
  ]);
  expect([...calls].sort()).toEqual(["ci", "intent", "review", "sections"]);
  const events = await changeEventsAfter(db, opened.id, 0);
  expect(events.map((event) => event.seq)).toEqual(events.map((_, index) => index + 1));
  expect(events[0]).toMatchObject({ type: "change.status", status: "processing" });
  expect(events.at(-1)).toMatchObject({ type: "change.status", status: "ready" });
  expect(events.filter((event) => event.type === "stage.status")).toHaveLength(8);
});

it("accepts the raw Artifacts event, and does nothing the second time it is delivered", async () => {
  const { run, push, change, stages, calls, session } = await world();
  const { ref, before, after } = push({ "src/b.ts": "b\n" });
  const event = {
    type: ARTIFACTS_PUSH_EVENT,
    id: "evt_1",
    source: { namespace: "gitflare", repoName: session.forkRepo },
    payload: { ref, before, after, commits: [] },
  } as unknown as PipelineParams;

  await run(event);
  const opened = await change();
  expect(opened).toMatchObject({ status: "ready", headSha: after });
  const ran = calls.length;

  await run(event);
  expect(calls).toHaveLength(ran);
  expect(await stages(opened.id)).toHaveLength(4);
  expect(await change()).toEqual(opened);
});

it("runs each stage once when the same push is delivered twice at the same time", async () => {
  const { run, push, change, stages, calls } = await world();
  const delivery: PipelineParams = { kind: "push", push: push({ "src/b.ts": "b\n" }) };

  // Two deliveries, and the one instance they both hand the stages to.
  expect(await run([delivery, delivery])).toBe(3);

  expect([...calls].sort()).toEqual(["ci", "intent", "review", "sections"]);
  const opened = await change();
  expect(opened.status).toBe("ready");
  expect(await stages(opened.id)).toHaveLength(4);
});

it("runs a re-run once when it is asked for twice at the same time", async () => {
  const { run, push, change, stages, calls, runtime } = await world();
  await run({ kind: "push", push: push({ "src/b.ts": "b\n" }) });
  const opened = await change();
  runtime.stages.review = async () => {
    calls.push("review");
    return { status: "succeeded" };
  };
  const before = calls.length;
  const rerun: PipelineParams = { kind: "rerun", changeId: opened.id, stage: "review" };

  await run([rerun, rerun]);

  expect(calls.slice(before)).toEqual(["review"]);
  expect((await stages(opened.id)).filter(([stage]) => stage === "review")).toEqual([
    ["review", 1, "failed", "the model is unavailable"],
    ["review", 2, "succeeded", null],
  ]);
});

it("waits a bounded time for the checkpoints the commits name, then goes on", async () => {
  const { run, push, change, ports } = await world();
  const checkpoint = "0123456789ab";
  // The checkpoint never arrives: the fake reports it missing for whichever change asks.
  const asked = vi.spyOn(ports.capture, "missingCheckpoints").mockResolvedValue([checkpoint]);

  await run({
    kind: "push",
    push: push({ "src/b.ts": "b\n" }, `Add b\n\nEntire-Checkpoint: ${checkpoint}`),
  });

  // Every five seconds for a minute, and once at the start.
  expect(asked).toHaveBeenCalledTimes(13);
  expect((await change()).status).toBe("ready");
});

it("re-runs one stage and brings the change back to ready", async () => {
  const { run, push, change, stages, runtime } = await world();
  await run({ kind: "push", push: push({ "src/b.ts": "b\n" }) });
  const opened = await change();
  runtime.stages.review = succeed;

  await run({ kind: "rerun", changeId: opened.id, stage: "review" });

  expect(await stages(opened.id)).toEqual([
    ["intent", 1, "succeeded", null],
    ["sections", 1, "succeeded", null],
    ["review", 1, "failed", "the model is unavailable"],
    ["ci", 1, "succeeded", null],
    ["review", 2, "succeeded", null],
  ]);
  expect(await change()).toMatchObject({ status: "ready" });
});

it("fails CI when it never reports, so the change still becomes ready", async () => {
  const { run, push, change, stages } = await world(null);

  await run({ kind: "push", push: push({ "src/b.ts": "b\n" }) }, { ciTimesOut: true });

  const opened = await change();
  expect(opened.status).toBe("ready");
  expect((await stages(opened.id)).find(([stage]) => stage === "ci")).toEqual([
    "ci",
    1,
    "failed",
    "CI did not report a result within 2 hours.",
  ]);
});

it("ends without a change for a push that is not a session's", async () => {
  const { run, ports, db, slug, session, calls } = await world();

  await run({ kind: "push", push: ports.git.push(slug, "main", { "x.ts": "x\n" }) });

  expect(
    await db.select().from(schema.changes).where(eq(schema.changes.sessionId, session.id)),
  ).toEqual([]);
  expect(calls).toEqual([]);
});
