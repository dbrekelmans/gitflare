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
import { schema } from "@gitflare/db";
import { eq } from "drizzle-orm";
import { type ArtifactsDeps, repositoryById, sessionById } from "./deps";

/**
 * Records a session and asks the provisioner to fork the main repo for it.
 * Forking takes seconds to most of a minute, so this returns before the fork
 * exists: `forkReadyAt` is null until `completeSessionFork` has run.
 */
export async function openSession(
  deps: ArtifactsDeps,
  user: User,
  input: { repository: Repository; kind: SessionKind; title: string },
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
  const id = deps.ids.next("session");
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
    createdAt: deps.clock.now(),
    forkReadyAt: null,
    endedAt: null,
    forkDeletedAt: null,
  };
  await deps.db.insert(schema.sessions).values(session);
  await deps.provisioning.forkSession(id);
  return session;
}

/**
 * The provisioning Workflow's fork step: forks the main repo if the fork does
 * not exist yet, and marks the session's fork ready once the host reports it
 * so. Throws while it is still being copied, so the step is retried.
 */
export async function completeSessionFork(
  deps: ArtifactsDeps,
  sessionId: SessionId,
): Promise<Session> {
  const session = await sessionById(deps.db, sessionId);
  // Ended before its fork was made, or already done: nothing to fork.
  if (session.status !== "active" || session.forkReadyAt) return session;

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
    .where(eq(schema.sessions.id, session.id));
  return { ...session, baseSha, forkReadyAt };
}
