/// <reference types="@cloudflare/vitest-plugin/types" />
import { introspectWorkflowInstance } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { openSession, provisionRepository } from "@gitflare/artifacts";
import type { ProvisionParams } from "@gitflare/core";
import { createIdGenerator } from "@gitflare/core/ports";
import { schema } from "@gitflare/db";
import { createD1Db } from "@gitflare/db/d1";
import { createFakePorts } from "@gitflare/testing";
import { demoUsers } from "@gitflare/testing/demo";
import { eq } from "drizzle-orm";
import { afterEach, expect, it } from "vitest";
import { ensureDevDatabase } from "../dev";
import type { Services } from "../services";
import { provisionRuntime } from "./provision";

// The real provisioning Workflow in workerd, with local D1, on fake ports.

const production = provisionRuntime.create;
afterEach(() => {
  provisionRuntime.create = production;
});

let worlds = 0;

async function world() {
  const ports = createFakePorts();
  const db = createD1Db(env.DB);
  const services: Services = { ...ports, ids: createIdGenerator(), db, mode: "dev" };
  await ensureDevDatabase(services, env.DB);
  provisionRuntime.create = () => services;

  /** Runs one instance to its end, with no waits between retries. */
  async function run(params: ProvisionParams) {
    const id = `provision-${++worlds}`;
    await using instance = await introspectWorkflowInstance(env.PROVISION, id);
    await instance.modify(async (modifier) => {
      await modifier.disableRetryDelays();
    });
    await env.PROVISION.create({ id, params });
    await instance.waitForStatus("complete");
  }

  return { ...ports, db, services, slug: `prov-${++worlds}`, run };
}

it("launches a cloud session only once its fork exists, with the prompt it was started with", async () => {
  const { services, git, cloudSessions, db, slug, run } = await world();
  const forks = new Set<string>();
  const fork = git.forkRepo.bind(git);
  git.forkRepo = async (source, name) => {
    const made = await fork(source, name);
    forks.add(name);
    return made;
  };
  const repository = await provisionRepository(services, demoUsers.maya, { slug, description: "" });
  const session = await openSession(services, demoUsers.jonas, {
    repository,
    kind: "cloud",
    title: "Export",
    prompt: "Add a CSV export.",
  });
  cloudSessions.forkReady = (sessionId) => sessionId === session.id && forks.has(session.forkRepo);

  await run({ kind: "fork", sessionId: session.id });

  expect(cloudSessions.launches).toEqual([{ sessionId: session.id, prompt: "Add a CSV export." }]);
  const [launch] = await db
    .select()
    .from(schema.sessionLaunches)
    .where(eq(schema.sessionLaunches.sessionId, session.id));
  expect(launch?.launchedAt).not.toBeNull();
  const [stored] = await db
    .select()
    .from(schema.sessions)
    .where(eq(schema.sessions.id, session.id));
  expect(stored?.forkReadyAt).not.toBeNull();
});

it("forks a local session and launches nothing", async () => {
  const { services, cloudSessions, db, slug, run } = await world();
  const repository = await provisionRepository(services, demoUsers.maya, { slug, description: "" });
  const session = await openSession(services, demoUsers.jonas, {
    repository,
    kind: "local",
    title: "Work",
  });

  await run({ kind: "fork", sessionId: session.id });

  expect(cloudSessions.launches).toEqual([]);
  const [stored] = await db
    .select()
    .from(schema.sessions)
    .where(eq(schema.sessions.id, session.id));
  expect(stored?.forkReadyAt).not.toBeNull();
});

it("marks an import failed once the step runs out of retries", async () => {
  const { services, git, db, slug, run } = await world();
  const url = "https://example.com/never.git";
  const repository = await provisionRepository(services, demoUsers.maya, {
    slug,
    description: "",
    importUrl: url,
  });
  // The host accepted the import and never finishes it.
  git.holdCopies = true;
  await git.importRepo(slug, { url });

  await run({ kind: "import", repositoryId: repository.id, url });

  const [stored] = await db
    .select()
    .from(schema.repositories)
    .where(eq(schema.repositories.id, repository.id));
  expect(stored).toMatchObject({ readyAt: null, importFailedAt: expect.any(Number) });
  expect(stored?.importError).toContain("still being imported");
});

it("records a workspace preparation that ran out of retries as failed", async () => {
  const { sandboxes, db, run } = await world();
  sandboxes.on(() => {
    throw new Error("the sandbox did not answer");
  });

  await run({ kind: "workspace" });

  const [organisation] = await db.select().from(schema.organisations).limit(1);
  expect(organisation?.settings.workspace.preparation).toMatchObject({
    state: "failed",
    error: expect.stringContaining("the sandbox did not answer"),
  });
});
