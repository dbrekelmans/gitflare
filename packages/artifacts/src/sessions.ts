import {
  can,
  ForgeError,
  forkRepoName,
  mainRepoName,
  type Repository,
  type Session,
  type SessionId,
  type SessionKind,
  type User,
} from "@gitflare/core";
import type { CloudSessions } from "@gitflare/core/ports";
import { schema } from "@gitflare/db";
import { and, eq, isNull } from "drizzle-orm";
import { type ArtifactsDeps, repositoryById, sessionById } from "./deps";

/**
 * Records a session and asks the provisioner to fork the main repo for it.
 * Forking takes seconds to most of a minute, so this returns before the fork
 * exists: `forkReadyAt` is null until `completeSessionFork` has run. A cloud
 * session's first prompt is stored with it, to be handed to the hosted agent
 * by `launchCloudSession` once the fork exists.
 */
export async function openSession(
  deps: ArtifactsDeps,
  user: User,
  input: { repository: Repository; kind: SessionKind; title: string; prompt?: string },
): Promise<Session> {
  const { repository } = input;
  if (!can(user, { type: "session.start" })) {
    throw new ForgeError("forbidden", "You are not allowed to start a session.");
  }
  if (repository.archivedAt) {
    throw new ForgeError("invalid", `${repository.slug} is archived.`);
  }
  if (!repository.readyAt || !repository.headSha) {
    throw new ForgeError("not_ready", `${repository.slug} is still being imported.`);
  }
  if (input.kind === "cloud" && input.prompt === undefined) {
    throw new ForgeError("invalid", "A cloud session starts with a prompt.");
  }
  const id = deps.ids.next("session");
  const now = deps.clock.now();
  const session: Session = {
    id,
    repositoryId: repository.id,
    userId: user.id,
    kind: input.kind,
    status: "active",
    title: input.title,
    forkRepo: forkRepoName(repository.slug, id),
    // Corrected to the fork's own tip once the fork exists.
    baseSha: repository.headSha,
    createdAt: now,
    forkReadyAt: null,
    endedAt: null,
    forkDeletedAt: null,
  };
  const insertSession = deps.db.insert(schema.sessions).values(session);
  if (input.kind === "cloud") {
    // Together: a cloud session never exists without the prompt it starts with.
    await deps.db.batch([
      insertSession,
      deps.db.insert(schema.sessionLaunches).values({
        sessionId: id,
        prompt: input.prompt ?? "",
        requestedAt: now,
        launchedAt: null,
      }),
    ]);
  } else {
    await insertSession;
  }
  await deps.provisioning.forkSession(id);
  return session;
}

/**
 * The provisioning Workflow's fork step: forks the main repo if the fork does
 * not exist yet, and marks the session's fork ready once the host reports it
 * so. Throws while it is still being copied, so the step is retried. A
 * session that ended while its fork was being copied gets no fork: the copy
 * is deleted, since whatever ended the session cleaned up before it existed.
 */
export async function completeSessionFork(
  deps: ArtifactsDeps,
  sessionId: SessionId,
): Promise<Session> {
  const session = await sessionById(deps.db, sessionId);
  if (session.forkReadyAt) return session;
  if (session.status !== "active") return discardFork(deps, session);

  const repository = await repositoryById(deps.db, session.repositoryId);
  let fork = await deps.git.getRepo(session.forkRepo);
  if (!fork) {
    try {
      fork = await deps.git.forkRepo(mainRepoName(repository.slug), session.forkRepo);
    } catch (error) {
      // Another run of this step got there first.
      if (!(error instanceof ForgeError && error.code === "conflict")) throw error;
      fork = await deps.git.getRepo(session.forkRepo);
    }
  }
  if (fork?.status !== "ready") {
    throw new ForgeError("not_ready", `${session.forkRepo} is still being copied`);
  }

  // The main repo can have moved between the request and the copy: the base
  // is what the fork actually started from.
  const baseSha =
    (await deps.git.resolveRef(session.forkRepo, fork.defaultBranch)) ?? session.baseSha;
  const forkReadyAt = deps.clock.now();
  await deps.db
    .update(schema.sessions)
    .set({ baseSha, forkReadyAt })
    .where(
      and(
        eq(schema.sessions.id, session.id),
        eq(schema.sessions.status, "active"),
        isNull(schema.sessions.forkDeletedAt),
      ),
    );
  // The copy can take most of a minute, and the session may have ended in it.
  const current = await sessionById(deps.db, session.id);
  return current.forkReadyAt ? current : discardFork(deps, current);
}

/** Deletes the fork of a session that ended without one, and records that it is gone. */
async function discardFork(deps: ArtifactsDeps, session: Session): Promise<Session> {
  await deps.git.deleteRepo(session.forkRepo);
  if (session.forkDeletedAt !== null) return session;
  const forkDeletedAt = deps.clock.now();
  await deps.db
    .update(schema.sessions)
    .set({ forkDeletedAt })
    .where(eq(schema.sessions.id, session.id));
  return { ...session, forkDeletedAt };
}

/**
 * The provisioning Workflow's step after the fork: hands a cloud session's
 * first prompt to the hosted agent and records that it was delivered. Does
 * nothing for a local session, one already launched, or one that has ended.
 * Throws `not_ready` while the fork is not ready, so it is never called
 * before `completeSessionFork` has finished. Safe to run twice: the port
 * ignores a second launch, and `launchedAt` stops this one from asking.
 */
export async function launchCloudSession(
  deps: Pick<ArtifactsDeps, "db" | "clock"> & { cloudSessions: CloudSessions },
  sessionId: SessionId,
): Promise<void> {
  const [launch] = await deps.db
    .select()
    .from(schema.sessionLaunches)
    .where(eq(schema.sessionLaunches.sessionId, sessionId))
    .limit(1);
  if (!launch || launch.launchedAt !== null) return;
  const session = await sessionById(deps.db, sessionId);
  if (session.status !== "active" || session.forkDeletedAt !== null) return;
  if (!session.forkReadyAt) {
    throw new ForgeError("not_ready", `The fork of session ${sessionId} is not ready.`);
  }
  await deps.cloudSessions.launch(sessionId, launch.prompt);
  await deps.db
    .update(schema.sessionLaunches)
    .set({ launchedAt: deps.clock.now() })
    .where(
      and(
        eq(schema.sessionLaunches.sessionId, sessionId),
        isNull(schema.sessionLaunches.launchedAt),
      ),
    );
}
