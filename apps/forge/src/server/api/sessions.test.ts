import { completeSessionFork, launchCloudSession } from "@gitflare/artifacts";
import type { ChangeId, SessionId } from "@gitflare/core";
import { type Db, schema } from "@gitflare/db";
import { createTestDb } from "@gitflare/db/testing";
import { createDemoPorts } from "@gitflare/testing";
import { demo, demoChanges, demoUsers } from "@gitflare/testing/demo";
import { seedDemo } from "@gitflare/testing/seed";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Services } from "../services";
import { sessionsApi } from "./sessions";

// `@gitflare/pipeline` is another task's package. What this slice owes it is
// the call: these stand-ins record it and do the least the real ones promise.
const pipeline = vi.hoisted(() => ({
  endSession: vi.fn(),
  closeChange: vi.fn(),
}));
vi.mock("@gitflare/pipeline", () => pipeline);

const REMOTE = "https://git.example.test/git/gitflare";
const { maya, jonas, priya } = demoUsers;
const [, reviewSession, cloudSession] = demo.sessions;

async function demoServices() {
  const ports = createDemoPorts();
  const db = createTestDb();
  await seedDemo(db);
  const services = { ...ports, db, mode: "dev" } satisfies Services;
  return { ...ports, db, services, api: sessionsApi(services) };
}

async function end(db: Db, sessionId: SessionId): Promise<void> {
  await db
    .update(schema.sessions)
    .set({ status: "abandoned", endedAt: 1, forkDeletedAt: 1 })
    .where(eq(schema.sessions.id, sessionId));
}

beforeEach(() => {
  pipeline.endSession
    .mockReset()
    .mockImplementation(async ({ db }, sessionId) => end(db, sessionId));
  pipeline.closeChange.mockReset().mockImplementation(async ({ db }, _user, changeId: ChangeId) => {
    const [change] = await db.select().from(schema.changes).where(eq(schema.changes.id, changeId));
    await db
      .update(schema.changes)
      .set({ status: "closed" })
      .where(eq(schema.changes.id, changeId));
    await end(db, change.sessionId);
  });
});

describe("sessions slice: starting", () => {
  it("starts a local session whose fork is requested and not ready", async () => {
    const { api, provisioning, git, services } = await demoServices();
    const started = await api.start(
      { user: priya },
      { repoSlug: "atlas-web", kind: "local", title: "Tidy the invite form" },
    );

    expect(started).toMatchObject({
      session: {
        userId: priya.id,
        kind: "local",
        status: "active",
        title: "Tidy the invite form",
        forkReadyAt: null,
      },
      repository: { id: "rep_atlas", slug: "atlas-web" },
      change: null,
      pushRemote: null,
      cloud: null,
    });
    expect(provisioning.forks).toEqual([started.session.id]);
    expect(await git.getRepo(started.session.forkRepo)).toBeNull();

    // What the provisioning Workflow does next; the CLI polls `get` for it.
    await completeSessionFork(services, started.session.id);
    const ready = await api.get({ user: priya }, { sessionId: started.session.id });
    expect(ready.session.forkReadyAt).not.toBeNull();
    expect(ready.pushRemote).toBe(`${REMOTE}/${started.session.forkRepo}.git`);
  });

  it("starts a cloud session whose prompt waits for the fork, then is launched", async () => {
    const { api, cloudSessions, git, provisioning, services, db } = await demoServices();
    // As the real port does: no launch for a fork the host has not finished.
    git.holdCopies = true;
    const ready = new Set<string>();
    cloudSessions.forkReady = (sessionId) => ready.has(sessionId);

    const started = await api.start(
      { user: priya },
      { repoSlug: "atlas-web", kind: "cloud", title: "Export", prompt: "Add a CSV export." },
    );
    const { id } = started.session;
    expect(provisioning.forks).toEqual([id]);
    expect(started.cloud).toMatchObject({ sessionId: id, state: "starting" });
    expect(cloudSessions.launches).toEqual([]);
    expect(
      await db
        .select()
        .from(schema.sessionLaunches)
        .where(eq(schema.sessionLaunches.sessionId, id)),
    ).toMatchObject([{ prompt: "Add a CSV export.", launchedAt: null }]);

    // The provisioning Workflow: the fork step, and then the launch step.
    await expect(completeSessionFork(services, id)).rejects.toMatchObject({ code: "not_ready" });
    git.finish(started.session.forkRepo);
    ready.add(id);
    await completeSessionFork(services, id);
    // Ready, but not launched yet: still starting, and the port is not asked.
    expect((await api.get({ user: priya }, { sessionId: id })).cloud).toMatchObject({
      state: "starting",
    });
    await launchCloudSession(services, id);

    expect(cloudSessions.launches).toEqual([{ sessionId: id, prompt: "Add a CSV export." }]);
    expect((await api.get({ user: priya }, { sessionId: id })).cloud).toMatchObject({
      state: "working",
    });
  });

  it("fails for a repository that does not exist", async () => {
    const { api, provisioning } = await demoServices();
    await expect(
      api.start({ user: priya }, { repoSlug: "nope", kind: "local", title: "x" }),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(provisioning.forks).toEqual([]);
  });
});

describe("sessions slice: reading", () => {
  it("shows a session with its change and where it pushes", async () => {
    const { api } = await demoServices();
    const view = await api.get({ user: maya }, { sessionId: reviewSession?.id ?? "ses_" });
    expect(view).toEqual({
      session: reviewSession,
      repository: { id: "rep_atlas", slug: "atlas-web" },
      change: {
        id: demoChanges.review.id,
        number: 12,
        title: demoChanges.review.title,
        status: "ready",
      },
      pushRemote: `${REMOTE}/${demo.git.repos.forks.review}.git`,
      cloud: null,
    });
    await expect(api.get({ user: maya }, { sessionId: "ses_nope" })).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("lists the caller's own sessions, newest first, without the deleted fork's remote", async () => {
    const { api } = await demoServices();
    expect((await api.listMine({ user: jonas })).map((view) => view.session.id)).toEqual([
      reviewSession?.id,
    ]);
    const [merged] = await api.listMine({ user: priya });
    expect(merged).toMatchObject({ session: { status: "merged" }, pushRemote: null });

    await api.start({ user: jonas }, { repoSlug: "atlas-web", kind: "local", title: "Second" });
    expect((await api.listMine({ user: jonas })).map((view) => view.session.title)).toEqual([
      "Second",
      reviewSession?.title,
    ]);
  });
});

describe("sessions slice: the hosted agent", () => {
  const cloudId = cloudSession?.id ?? "ses_";

  it("passes prompts, events and stop through to the port", async () => {
    const { api, cloudSessions } = await demoServices();
    // The port takes a prompt only for a session that was launched.
    await cloudSessions.launch(cloudId, "Add an export function.");
    await api.prompt({ user: maya }, { sessionId: cloudId, text: "Also add a header row." });
    cloudSessions.emit(cloudId, { type: "assistant", text: "Done." });

    expect(await api.events({ user: jonas }, { sessionId: cloudId, after: 0 })).toMatchObject([
      { seq: 1, type: "prompt", text: "Add an export function." },
      { seq: 2, type: "prompt", text: "Also add a header row." },
      { seq: 3, type: "assistant", text: "Done." },
    ]);
    expect(await api.events({ user: jonas }, { sessionId: cloudId, after: 2 })).toHaveLength(1);

    const stopped = await api.stop({ user: maya }, { sessionId: cloudId });
    expect(stopped.cloud?.state).toBe("asleep");
    expect((await cloudSessions.status(cloudId)).state).toBe("asleep");
  });

  it("lets only the session's owner drive it, and only a cloud session", async () => {
    const { api, cloudSessions } = await demoServices();
    await expect(
      api.prompt({ user: jonas }, { sessionId: cloudId, text: "hi" }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(api.stop({ user: jonas }, { sessionId: cloudId })).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(
      api.prompt({ user: jonas }, { sessionId: reviewSession?.id ?? "ses_", text: "hi" }),
    ).rejects.toMatchObject({ code: "invalid" });
    expect(await cloudSessions.events(cloudId, 0)).toEqual([]);
  });

  it("refuses a prompt before the fork is ready", async () => {
    const { api } = await demoServices();
    const started = await api.start(
      { user: priya },
      { repoSlug: "atlas-web", kind: "cloud", title: "Export", prompt: "Go." },
    );
    await expect(
      api.prompt({ user: priya }, { sessionId: started.session.id, text: "More." }),
    ).rejects.toMatchObject({ code: "not_ready" });
  });
});

describe("sessions slice: abandoning", () => {
  it("ends a session that has no change through endSession", async () => {
    const { api, services } = await demoServices();
    const { session } = await api.start(
      { user: priya },
      { repoSlug: "atlas-web", kind: "local", title: "Never mind" },
    );

    const view = await api.abandon({ user: priya }, { sessionId: session.id });
    expect(pipeline.endSession).toHaveBeenCalledExactlyOnceWith(services, session.id, "abandoned");
    expect(pipeline.closeChange).not.toHaveBeenCalled();
    // The view is read back after the session was ended.
    expect(view.session.status).toBe("abandoned");
  });

  it("closes the change of a session that has one, which ends the session", async () => {
    const { api, services } = await demoServices();
    const view = await api.abandon({ user: jonas }, { sessionId: reviewSession?.id ?? "ses_" });

    expect(pipeline.closeChange).toHaveBeenCalledExactlyOnceWith(
      services,
      jonas,
      demoChanges.review.id,
    );
    expect(pipeline.endSession).not.toHaveBeenCalled();
    expect(view).toMatchObject({
      session: { status: "abandoned" },
      change: { id: demoChanges.review.id, status: "closed" },
      pushRemote: null,
    });
  });

  it("stops a hosted session's sandbox before ending it", async () => {
    const { api, cloudSessions } = await demoServices();
    const cloudId = cloudSession?.id ?? "ses_";
    const view = await api.abandon({ user: maya }, { sessionId: cloudId });

    expect((await cloudSessions.status(cloudId)).state).toBe("asleep");
    expect(pipeline.closeChange).toHaveBeenCalledOnce();
    expect(view.cloud?.state).toBe("ended");
  });

  it("is for the owner or an administrator, and only while the session is active", async () => {
    const { api } = await demoServices();
    const sessionId = reviewSession?.id ?? "ses_";
    await expect(api.abandon({ user: priya }, { sessionId })).rejects.toMatchObject({
      code: "forbidden",
    });
    expect(pipeline.closeChange).not.toHaveBeenCalled();

    // Maya is an administrator, not the owner.
    await api.abandon({ user: maya }, { sessionId });
    expect(pipeline.closeChange).toHaveBeenCalledOnce();
    await expect(api.abandon({ user: maya }, { sessionId })).rejects.toMatchObject({
      code: "forbidden",
    });
    expect(pipeline.closeChange).toHaveBeenCalledOnce();
  });
});
