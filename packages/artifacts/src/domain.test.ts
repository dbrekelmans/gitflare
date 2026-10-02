import { forkRepoName, type Repository, type Session, type User } from "@gitflare/core";
import { schema } from "@gitflare/db";
import { createTestDb } from "@gitflare/db/testing";
import { createFakePorts, type FakeGit } from "@gitflare/testing";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ArtifactsDeps } from "./deps";
import {
  completeRepositoryImport,
  failRepositoryImport,
  provisionRepository,
} from "./repositories";
import { completeSessionFork, launchCloudSession, openSession } from "./sessions";
import { LocalArtifacts } from "./testing/local-artifacts";
import { issueGitCredential, mintSystemToken } from "./tokens";

const REMOTE = "https://git.example.test/git/gitflare";

function person(id: string, role: User["role"]): User {
  return {
    id: `usr_${id}`,
    organisationId: "org_1",
    subject: `test|${id}`,
    email: `${id}@example.com`,
    name: id,
    role,
    createdAt: 0,
    lastSeenAt: null,
  };
}
const admin = person("admin", "admin");
const ada = person("ada", "member");
const bob = person("bob", "member");

function setup(overrides: Partial<ArtifactsDeps> = {}) {
  const ports = createFakePorts();
  const db = createTestDb();
  const deps = { ...ports, db, ...overrides };
  return { ...ports, db, deps };
}

/**
 * Makes the hosted-session fake refuse a launch, as the real port does, until
 * the host reports the session's fork of `app` ready.
 */
function launchOnlyOnReadyForks(world: ReturnType<typeof setup>): void {
  const ready = new Set<string>();
  const git: FakeGit = world.git;
  const fork = git.forkRepo.bind(git);
  git.forkRepo = async (source, name) => {
    const made = await fork(source, name);
    if (made.status === "ready") ready.add(name);
    return made;
  };
  const finish = git.finish.bind(git);
  git.finish = (name) => {
    finish(name);
    ready.add(name);
  };
  world.cloudSessions.forkReady = (sessionId) => ready.has(forkRepoName("app", sessionId));
}

/** A ready repository, and a session of Ada's with its fork made. */
async function withSession(world: ReturnType<typeof setup>): Promise<{
  repository: Repository;
  session: Session;
}> {
  const repository = await provisionRepository(world.deps, admin, { slug: "app", description: "" });
  const opened = await openSession(world.deps, ada, { repository, kind: "local", title: "Work" });
  return { repository, session: await completeSessionFork(world.deps, opened.id) };
}

describe("provisionRepository", () => {
  it("creates the main and context repos and commits the capture settings", async () => {
    const world = setup();
    const repository = await provisionRepository(world.deps, admin, {
      slug: "app",
      description: "An app",
    });

    expect(await world.git.getRepo("app")).toMatchObject({ status: "ready" });
    expect(await world.git.getRepo("app.context")).toMatchObject({ status: "ready" });
    const tip = await world.git.resolveRef("app", "main");
    expect(repository).toMatchObject({
      slug: "app",
      description: "An app",
      organisationId: "org_1",
      headSha: tip,
      captureEnabled: true,
      readyAt: world.clock.now(),
    });
    // The capture client is told to push checkpoints to the sibling repo, by
    // the path the host gave it.
    const settings = JSON.parse(
      (await world.git.text("app", "main", ".entire/settings.json")) ?? "",
    );
    expect(settings.strategy_options.checkpoint_remote).toEqual({
      provider: "artifacts",
      repo: "git/gitflare/app.context",
    });
    expect(await world.db.select().from(schema.repositories)).toMatchObject([
      { id: repository.id, slug: "app", headSha: tip },
    ]);
    expect(world.provisioning.imports).toEqual([]);
  });

  it("is refused for a member, and for a slug that is taken", async () => {
    const world = setup();
    await expect(
      provisionRepository(world.deps, ada, { slug: "app", description: "" }),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(await world.git.getRepo("app")).toBeNull();

    await provisionRepository(world.deps, admin, { slug: "app", description: "" });
    await expect(
      provisionRepository(world.deps, admin, { slug: "app", description: "" }),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("finishes what an attempt that failed half-way left on the host", async () => {
    const world = setup();
    await world.git.createRepo("app");
    const repository = await provisionRepository(world.deps, admin, {
      slug: "app",
      description: "",
    });
    expect(repository.headSha).toBe(await world.git.resolveRef("app", "main"));
  });

  it("hands an import to the provisioner and returns before it exists", async () => {
    const world = setup();
    const repository = await provisionRepository(world.deps, admin, {
      slug: "app",
      description: "",
      importUrl: "https://example.com/app.git",
    });
    expect(repository).toMatchObject({ readyAt: null, headSha: null, captureEnabled: false });
    expect(world.provisioning.imports).toEqual([
      { repositoryId: repository.id, url: "https://example.com/app.git" },
    ]);
    expect(await world.git.getRepo("app")).toBeNull();
  });
});

describe("completeRepositoryImport", () => {
  let upstream: LocalArtifacts | undefined;
  afterEach(() => upstream?.cleanup());

  /** A public repository elsewhere, of a few hundred bytes. */
  async function source(): Promise<{ url: string; fetch: LocalArtifacts["fetch"] }> {
    upstream = new LocalArtifacts();
    await upstream.create("elsewhere");
    upstream.commit("elsewhere", "main", { "README.md": "hello\n".repeat(50) });
    upstream.publicRead.add("elsewhere");
    return { url: upstream.remote("elsewhere"), fetch: upstream.fetch };
  }

  async function importing(overrides: Partial<ArtifactsDeps> = {}) {
    const { url, fetch } = await source();
    const world = setup({ fetch, ...overrides });
    const repository = await provisionRepository(world.deps, admin, {
      slug: "app",
      description: "",
      importUrl: url,
    });
    return { world, repository, url };
  }

  it("imports, commits the capture settings and marks the repository ready", async () => {
    const { world, repository, url } = await importing();
    const ready = await completeRepositoryImport(world.deps, repository.id, url);

    expect(await world.git.getRepo("app")).toMatchObject({ status: "ready", source: url });
    expect(await world.git.getRepo("app.context")).not.toBeNull();
    const tip = await world.git.resolveRef("app", "main");
    expect(ready).toMatchObject({ readyAt: world.clock.now(), headSha: tip, captureEnabled: true });
    expect(await world.git.text("app", "main", ".entire/settings.json")).toContain("app.context");
    expect(await world.db.select().from(schema.repositories)).toMatchObject([
      { readyAt: world.clock.now(), headSha: tip, captureEnabled: true },
    ]);

    // The step can run again: nothing is imported or committed twice.
    const pushes = world.git.pushes.length;
    expect(await completeRepositoryImport(world.deps, repository.id, url)).toEqual(ready);
    expect(world.git.pushes).toHaveLength(pushes);
  });

  it("throws while the host is still importing, so the step is retried", async () => {
    const { world, repository, url } = await importing();
    world.git.holdCopies = true;
    await expect(completeRepositoryImport(world.deps, repository.id, url)).rejects.toMatchObject({
      code: "not_ready",
    });
    await expect(completeRepositoryImport(world.deps, repository.id, url)).rejects.toMatchObject({
      code: "not_ready",
    });
    expect((await world.db.select().from(schema.repositories))[0]?.readyAt).toBeNull();

    world.git.finish("app");
    const ready = await completeRepositoryImport(world.deps, repository.id, url);
    expect(ready.readyAt).toBe(world.clock.now());
  });

  it("records that a source larger than the host allows failed, and imports nothing", async () => {
    const { world, repository, url } = await importing({ maxImportBytes: 100 });
    const result = await completeRepositoryImport(world.deps, repository.id, url);
    expect(result).toMatchObject({
      readyAt: null,
      importFailedAt: world.clock.now(),
      importError: expect.stringContaining("larger than the 100 bytes"),
    });
    expect(await world.git.getRepo("app")).toBeNull();
    expect(await world.db.select().from(schema.repositories)).toMatchObject([
      { importFailedAt: world.clock.now(), importError: result.importError },
    ]);
  });

  it("records that a source that cannot be read failed, and does not try it again", async () => {
    const { world, repository } = await importing();
    const gone = `${upstream?.remote("gone")}`;
    const result = await completeRepositoryImport(world.deps, repository.id, gone);
    expect(result).toMatchObject({
      readyAt: null,
      importFailedAt: world.clock.now(),
      importError: expect.stringContaining("cannot be read"),
    });
    expect(await world.git.getRepo("app")).toBeNull();

    // A retried step leaves the failure as it was.
    world.clock.advance(1000);
    expect(await completeRepositoryImport(world.deps, repository.id, gone)).toEqual(result);
  });

  it("records a failure the Workflow gave up on", async () => {
    const { world, repository } = await importing();
    const failed = await failRepositoryImport(world.deps, repository.id, "The import timed out.");
    expect(failed).toMatchObject({
      readyAt: null,
      importFailedAt: world.clock.now(),
      importError: "The import timed out.",
    });
  });

  it("never records a failure over an import that finished", async () => {
    const { world, repository, url } = await importing();
    const ready = await completeRepositoryImport(world.deps, repository.id, url);
    expect(await failRepositoryImport(world.deps, repository.id, "late")).toEqual(ready);
    expect(ready).toMatchObject({ importFailedAt: null, importError: null });
  });

  it("replaces a failed import with a new repository of the same slug", async () => {
    const { world, repository, url } = await importing({ maxImportBytes: 100 });
    // What the host may have kept of an attempt that timed out.
    await world.git.createRepo("app");
    await failRepositoryImport(world.deps, repository.id, "The import timed out.");

    const again = await provisionRepository(world.deps, admin, {
      slug: "app",
      description: "Second try",
      importUrl: url,
    });
    expect(again.id).not.toBe(repository.id);
    expect(again).toMatchObject({ importFailedAt: null, importError: null, readyAt: null });
    expect(await world.db.select().from(schema.repositories)).toMatchObject([
      { id: again.id, slug: "app", description: "Second try" },
    ]);
    // The new import starts from nothing, so it measures and imports the source afresh.
    expect(await world.git.getRepo("app")).toBeNull();
    expect(world.provisioning.imports.map((entry) => entry.repositoryId)).toEqual([
      repository.id,
      again.id,
    ]);

    // Still a conflict while that import is running, and once it is ready.
    await expect(
      provisionRepository(world.deps, admin, { slug: "app", description: "" }),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("replaces a failed import with a repository created empty", async () => {
    const { world, repository, url } = await importing({ maxImportBytes: 100 });
    await completeRepositoryImport(world.deps, repository.id, url);
    const created = await provisionRepository(world.deps, admin, { slug: "app", description: "" });
    expect(created.readyAt).toBe(world.clock.now());
    expect(await world.db.select().from(schema.repositories)).toMatchObject([
      { id: created.id, importFailedAt: null },
    ]);
  });
});

describe("openSession and completeSessionFork", () => {
  it("records the session and asks for its fork, which does not exist yet", async () => {
    const world = setup();
    const repository = await provisionRepository(world.deps, admin, {
      slug: "app",
      description: "",
    });
    const session = await openSession(world.deps, ada, {
      repository,
      kind: "local",
      title: "Work",
    });

    expect(session).toMatchObject({
      repositoryId: repository.id,
      userId: ada.id,
      kind: "local",
      status: "active",
      title: "Work",
      forkRepo: `app.fork.${session.id.slice("ses_".length)}`,
      baseSha: repository.headSha,
      forkReadyAt: null,
    });
    expect(world.provisioning.forks).toEqual([session.id]);
    expect(await world.git.getRepo(session.forkRepo)).toBeNull();
    expect(await world.db.select().from(schema.sessions)).toEqual([session]);
  });

  it("refuses a repository that is not ready", async () => {
    const world = setup();
    const repository = await provisionRepository(world.deps, admin, {
      slug: "app",
      description: "",
      importUrl: "https://example.com/app.git",
    });
    await expect(
      openSession(world.deps, ada, { repository, kind: "local", title: "Work" }),
    ).rejects.toMatchObject({ code: "not_ready" });
    expect(world.provisioning.forks).toEqual([]);
  });

  it("throws until the copy is finished, then marks the fork ready", async () => {
    const world = setup();
    const repository = await provisionRepository(world.deps, admin, {
      slug: "app",
      description: "",
    });
    const session = await openSession(world.deps, ada, {
      repository,
      kind: "local",
      title: "Work",
    });

    world.git.holdCopies = true;
    await expect(completeSessionFork(world.deps, session.id)).rejects.toMatchObject({
      code: "not_ready",
    });
    // The fork was requested once; the retry waits for it instead of forking again.
    expect(await world.git.getRepo(session.forkRepo)).toMatchObject({ status: "forking" });
    await expect(completeSessionFork(world.deps, session.id)).rejects.toMatchObject({
      code: "not_ready",
    });
    expect((await world.db.select().from(schema.sessions))[0]?.forkReadyAt).toBeNull();

    world.git.finish(session.forkRepo);
    world.clock.advance(41_000);
    const ready = await completeSessionFork(world.deps, session.id);
    expect(ready.forkReadyAt).toBe(world.clock.now());
    expect(await world.db.select().from(schema.sessions)).toEqual([ready]);

    // Run again, as a Workflow step can be: the same answer, nothing redone.
    world.clock.advance(1000);
    expect(await completeSessionFork(world.deps, session.id)).toEqual(ready);
  });

  it("takes the base from the fork itself when the main repo moved before the copy", async () => {
    const world = setup();
    const repository = await provisionRepository(world.deps, admin, {
      slug: "app",
      description: "",
    });
    const session = await openSession(world.deps, ada, {
      repository,
      kind: "local",
      title: "Work",
    });
    const moved = world.git.push("app", "main", { "README.md": "later\n" }).after;

    const ready = await completeSessionFork(world.deps, session.id);
    expect(session.baseSha).toBe(repository.headSha);
    expect(ready.baseSha).toBe(moved);
  });

  it("deletes a fork whose session ended while it was being copied", async () => {
    const world = setup();
    const repository = await provisionRepository(world.deps, admin, {
      slug: "app",
      description: "",
    });
    const session = await openSession(world.deps, ada, {
      repository,
      kind: "local",
      title: "Work",
    });
    // The session is abandoned during the copy, which took 41 s live: its
    // clean-up ran before the fork existed, so found nothing to delete.
    const fork = world.git.forkRepo.bind(world.git);
    world.git.forkRepo = async (source, name) => {
      await world.db
        .update(schema.sessions)
        .set({ status: "abandoned", endedAt: world.clock.now(), forkDeletedAt: world.clock.now() })
        .where(eq(schema.sessions.id, session.id));
      return fork(source, name);
    };

    const ended = await completeSessionFork(world.deps, session.id);
    expect(ended).toMatchObject({ status: "abandoned", forkReadyAt: null });
    expect(await world.git.getRepo(session.forkRepo)).toBeNull();
    expect((await world.db.select().from(schema.sessions))[0]?.forkReadyAt).toBeNull();
  });

  it("deletes a fork that was already copied when a retry finds the session ended", async () => {
    const world = setup();
    const repository = await provisionRepository(world.deps, admin, {
      slug: "app",
      description: "",
    });
    const session = await openSession(world.deps, ada, {
      repository,
      kind: "local",
      title: "Work",
    });
    world.git.holdCopies = true;
    await expect(completeSessionFork(world.deps, session.id)).rejects.toMatchObject({
      code: "not_ready",
    });
    world.git.finish(session.forkRepo);
    await world.db.update(schema.sessions).set({ status: "abandoned", endedAt: 1 });

    const ended = await completeSessionFork(world.deps, session.id);
    expect(ended).toMatchObject({ forkReadyAt: null, forkDeletedAt: world.clock.now() });
    expect(await world.git.getRepo(session.forkRepo)).toBeNull();
  });

  it("makes no fork for a session that has already ended", async () => {
    const world = setup();
    const repository = await provisionRepository(world.deps, admin, {
      slug: "app",
      description: "",
    });
    const session = await openSession(world.deps, ada, {
      repository,
      kind: "local",
      title: "Work",
    });
    await world.db.update(schema.sessions).set({ status: "abandoned" });

    expect((await completeSessionFork(world.deps, session.id)).forkReadyAt).toBeNull();
    expect(await world.git.getRepo(session.forkRepo)).toBeNull();
  });
});

describe("a cloud session's launch", () => {
  async function cloud(world: ReturnType<typeof setup>) {
    const repository = await provisionRepository(world.deps, admin, {
      slug: "app",
      description: "",
    });
    return openSession(world.deps, ada, {
      repository,
      kind: "cloud",
      title: "Export",
      prompt: "Add a CSV export.",
    });
  }

  it("keeps the first prompt with the session, and launches nothing", async () => {
    const world = setup();
    const session = await cloud(world);
    expect(await world.db.select().from(schema.sessionLaunches)).toEqual([
      {
        sessionId: session.id,
        prompt: "Add a CSV export.",
        requestedAt: world.clock.now(),
        launchedAt: null,
      },
    ]);
    expect(world.cloudSessions.launches).toEqual([]);
  });

  it("is refused without a prompt; a local session keeps none", async () => {
    const world = setup();
    const repository = await provisionRepository(world.deps, admin, {
      slug: "app",
      description: "",
    });
    await expect(
      openSession(world.deps, ada, { repository, kind: "cloud", title: "Export" }),
    ).rejects.toMatchObject({ code: "invalid" });
    await openSession(world.deps, ada, { repository, kind: "local", title: "Work" });
    expect(await world.db.select().from(schema.sessionLaunches)).toEqual([]);
    expect(await world.db.select().from(schema.sessions)).toHaveLength(1);
  });

  it("is delivered once the fork exists, and only once", async () => {
    const world = setup();
    launchOnlyOnReadyForks(world);
    const session = await cloud(world);

    // The Workflow's launch step, run before the fork step finished.
    world.git.holdCopies = true;
    await expect(completeSessionFork(world.deps, session.id)).rejects.toMatchObject({
      code: "not_ready",
    });
    await expect(launchCloudSession(world.deps, session.id)).rejects.toMatchObject({
      code: "not_ready",
    });
    expect(world.cloudSessions.launches).toEqual([]);

    world.git.finish(session.forkRepo);
    await completeSessionFork(world.deps, session.id);
    world.clock.advance(500);
    await launchCloudSession(world.deps, session.id);
    expect(world.cloudSessions.launches).toEqual([
      { sessionId: session.id, prompt: "Add a CSV export." },
    ]);
    expect(await world.db.select().from(schema.sessionLaunches)).toMatchObject([
      { sessionId: session.id, launchedAt: world.clock.now() },
    ]);

    // A retried step asks the port nothing.
    const launch = vi.spyOn(world.cloudSessions, "launch");
    await launchCloudSession(world.deps, session.id);
    expect(launch).not.toHaveBeenCalled();
  });

  it("is delivered again when the step died between the launch and recording it", async () => {
    const world = setup();
    launchOnlyOnReadyForks(world);
    const session = await cloud(world);
    await completeSessionFork(world.deps, session.id);
    // The port launched; the write that would record it never happened.
    await world.cloudSessions.launch(session.id, "Add a CSV export.");

    await launchCloudSession(world.deps, session.id);
    expect(world.cloudSessions.launches).toHaveLength(1);
    expect((await world.db.select().from(schema.sessionLaunches))[0]?.launchedAt).toBe(
      world.clock.now(),
    );
  });

  it("does nothing for a session that ended before its launch", async () => {
    const world = setup();
    const session = await cloud(world);
    await completeSessionFork(world.deps, session.id);
    await world.db.update(schema.sessions).set({ status: "abandoned", endedAt: 1 });

    await launchCloudSession(world.deps, session.id);
    expect(world.cloudSessions.launches).toEqual([]);
  });
});

describe("issueGitCredential", () => {
  it("gives read on the main repo, never write, and records it", async () => {
    const world = setup();
    await withSession(world);
    const credential = await issueGitCredential(world.deps, bob, `${REMOTE}/app.git`);

    const [token] = world.git.tokens.slice(-1);
    expect(token).toMatchObject({ repo: "app", scope: "read", revoked: false });
    expect(credential).toEqual({
      username: "gitflare",
      password: token?.secret,
      expiresAt: world.clock.now() + 3_600_000,
    });
    expect(await world.db.select().from(schema.gitTokens)).toEqual([
      {
        tokenId: token?.id,
        repoName: "app",
        userId: bob.id,
        sessionId: null,
        scope: "read",
        purpose: "clone",
        expiresAt: credential.expiresAt,
        createdAt: world.clock.now(),
        revokedAt: null,
      },
    ]);
  });

  it("gives write on the caller's own fork and on the context repo", async () => {
    const world = setup();
    const { session } = await withSession(world);

    await issueGitCredential(world.deps, ada, `${REMOTE}/${session.forkRepo}.git`);
    // Git reports the remote as the user typed it: without `.git` is the same remote.
    await issueGitCredential(world.deps, ada, `${REMOTE}/app.context`);
    expect(await world.db.select().from(schema.gitTokens)).toMatchObject([
      {
        repoName: session.forkRepo,
        userId: ada.id,
        sessionId: session.id,
        scope: "write",
        purpose: "session_push",
      },
      {
        repoName: "app.context",
        userId: ada.id,
        sessionId: null,
        scope: "write",
        purpose: "checkpoint_push",
      },
    ]);
    expect(world.git.tokens.slice(-2).map((token) => [token.repo, token.scope])).toEqual([
      [session.forkRepo, "write"],
      ["app.context", "write"],
    ]);
  });

  it("refuses another user's fork, even for an administrator, and mints nothing", async () => {
    const world = setup();
    const { session } = await withSession(world);
    const minted = world.git.tokens.length;

    for (const user of [bob, admin]) {
      await expect(
        issueGitCredential(world.deps, user, `${REMOTE}/${session.forkRepo}.git`),
      ).rejects.toMatchObject({ code: "forbidden" });
    }
    expect(world.git.tokens).toHaveLength(minted);
    expect(await world.db.select().from(schema.gitTokens)).toEqual([]);
  });

  it("refuses a fork whose session has ended, and waits for one still being copied", async () => {
    const world = setup();
    const { repository, session } = await withSession(world);
    const pending = await openSession(world.deps, ada, {
      repository,
      kind: "local",
      title: "Next",
    });
    await expect(
      issueGitCredential(world.deps, ada, `${REMOTE}/${pending.forkRepo}.git`),
    ).rejects.toMatchObject({ code: "not_ready" });

    await world.db.update(schema.sessions).set({ status: "merged" });
    await expect(
      issueGitCredential(world.deps, ada, `${REMOTE}/${session.forkRepo}.git`),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("waits for a main repo still being imported, and refuses one whose import failed", async () => {
    const world = setup();
    const repository = await provisionRepository(world.deps, admin, {
      slug: "app",
      description: "",
      importUrl: "https://example.com/app.git",
    });
    for (const remote of [`${REMOTE}/app.git`, `${REMOTE}/app.context.git`]) {
      await expect(issueGitCredential(world.deps, ada, remote)).rejects.toMatchObject({
        code: "not_ready",
      });
    }
    await failRepositoryImport(world.deps, repository.id, "The import timed out.");
    await expect(issueGitCredential(world.deps, ada, `${REMOTE}/app.git`)).rejects.toMatchObject({
      code: "forbidden",
    });
    expect(world.git.tokens).toEqual([]);
  });

  it("refuses a remote that is not this deployment's, whatever it is called", async () => {
    const world = setup();
    await withSession(world);
    const minted = world.git.tokens.length;
    for (const remote of [
      // Git would send the token to this host.
      "https://evil.example/git/gitflare/app.git",
      "https://git.example.test/git/other-namespace/app.git",
      `${REMOTE}/unknown.git`,
      `${REMOTE}/app.weird.git`,
      "not a url",
    ]) {
      await expect(issueGitCredential(world.deps, ada, remote)).rejects.toMatchObject({
        code: "forbidden",
      });
    }
    expect(world.git.tokens).toHaveLength(minted);
  });

  it("revokes a token it could not record instead of handing it out", async () => {
    const world = setup();
    await withSession(world);
    const next = `tok_${world.git.tokens.length + 1}`;
    await world.db.insert(schema.gitTokens).values({
      tokenId: next,
      repoName: "app",
      userId: null,
      sessionId: null,
      scope: "read",
      purpose: "system",
      expiresAt: 0,
      createdAt: 0,
      revokedAt: null,
    });

    await expect(issueGitCredential(world.deps, ada, `${REMOTE}/app.git`)).rejects.toThrow();
    expect(world.git.tokens.at(-1)).toMatchObject({ id: next, revoked: true });
  });
});

describe("mintSystemToken", () => {
  it("records a token that belongs to no user, tied to the session of a fork", async () => {
    const world = setup();
    const { session } = await withSession(world);

    const main = await mintSystemToken(world.deps, "app", "write", "system");
    const fork = await mintSystemToken(world.deps, session.forkRepo, "read", "sandbox");
    expect(main.secret).toBe(world.git.tokens.at(-2)?.secret);
    expect(await world.db.select().from(schema.gitTokens)).toEqual([main.grant, fork.grant]);
    expect(main.grant).toMatchObject({
      repoName: "app",
      userId: null,
      sessionId: null,
      scope: "write",
      purpose: "system",
    });
    expect(fork.grant).toMatchObject({
      userId: null,
      sessionId: session.id,
      scope: "read",
      purpose: "sandbox",
    });
  });
});
