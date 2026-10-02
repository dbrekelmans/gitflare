import {
  type Change,
  type ChangeId,
  can,
  canTransitionChange,
  ForgeError,
  type MergeBlocker,
  type MergeReadiness,
  mainRepoName,
  mergeReadiness,
  type Session,
  type SessionId,
  transitionChange,
  transitionSession,
  type User,
} from "@gitflare/core";
import { type Db, schema, toChange, toSection } from "@gitflare/db";
import { and, eq, isNull, ne } from "drizzle-orm";
import {
  type ChangeRow,
  emit,
  headStageRuns,
  type PipelineDeps,
  requireChange,
  requireSession,
} from "./deps";

const { approvals, changes, gitTokens, repositories, sections, sessions, threads } = schema;

/** Whether a change may merge, from the database as it stands. */
export async function changeReadiness(db: Db, change: ChangeRow): Promise<MergeReadiness> {
  const [stages, sectionRows, approvalRows, threadRows] = await Promise.all([
    headStageRuns(db, change.headRevisionId),
    db
      .select()
      .from(sections)
      .where(and(eq(sections.changeId, change.id), isNull(sections.removedAt)))
      .orderBy(sections.position),
    db.select().from(approvals).where(eq(approvals.changeId, change.id)),
    db.select().from(threads).where(eq(threads.changeId, change.id)).orderBy(threads.createdAt),
  ]);
  return mergeReadiness({
    change,
    headStageRuns: stages,
    sections: sectionRows.map(toSection),
    approvals: approvalRows,
    threads: threadRows,
  });
}

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** A blocker in the words the merge refusal uses. */
export function describeBlocker(blocker: MergeBlocker): string {
  switch (blocker.kind) {
    case "status":
      return `it is ${blocker.status}`;
    case "no_sections":
      return "it has no sections to approve";
    case "sections_unapproved":
      return `${count(blocker.sectionIds.length, "section is", "sections are")} not approved`;
    case "comments_open":
      return `${count(blocker.threadIds.length, "comment is", "comments are")} still open`;
    case "ci_not_green":
      return blocker.status === "missing" ? "CI has not run" : `CI is ${blocker.status}`;
  }
}

/**
 * Merges a ready change into the main repo. Checks `mergeReadiness` first and
 * fails with `not_ready`; a merge conflict fails with `conflict` and leaves
 * the change as it was. On success it records the merge, settles the change's
 * decisions and ends the session.
 */
export async function mergeChange(
  deps: PipelineDeps,
  user: User,
  changeId: ChangeId,
): Promise<Change> {
  const { db } = deps;
  if (!can(user, { type: "change.merge" })) {
    throw new ForgeError("forbidden", "You are not allowed to merge changes.");
  }
  const change = await requireChange(db, changeId);
  const session = await requireSession(db, change.sessionId);

  if (change.status !== "merged") {
    const readiness = await changeReadiness(db, change);
    if (!readiness.ready) {
      throw new ForgeError(
        "not_ready",
        `Change #${change.number} cannot merge yet: ${readiness.blockers.map(describeBlocker).join("; ")}.`,
      );
    }
    const [repository] = await db
      .select()
      .from(repositories)
      .where(eq(repositories.id, change.repositoryId));
    if (!repository) throw new ForgeError("not_found", "Repository not found.");

    // What merges is what was reviewed. A push the change has not taken in yet would be
    // deleted with the fork, so the merge waits for it to become a revision. Its event
    // may have been lost: raising the push again is what makes the wait end.
    const tip = await deps.git.resolveRef(
      session.forkRepo,
      change.headRef.replace(/^refs\/heads\//, ""),
    );
    if (tip && tip !== change.headSha) {
      await deps.pipeline.handlePush({
        repoName: session.forkRepo,
        ref: change.headRef,
        before: change.headSha,
        after: tip,
      });
      throw new ForgeError(
        "not_ready",
        `Change #${change.number} cannot merge yet: its branch has a push that is not part of the change yet. It is being taken in now.`,
      );
    }
    const result = await deps.gitWriter.merge({
      target: { repo: mainRepoName(repository.slug), branch: repository.defaultBranch },
      source: { repo: session.forkRepo, sha: change.headSha },
      message: `Merge change #${change.number}: ${change.title}`,
      author: { name: user.name, email: user.email },
    });
    if (result.status === "conflict") {
      throw new ForgeError(
        "conflict",
        `Change #${change.number} conflicts with ${repository.defaultBranch} in ${result.paths.join(", ")}.`,
      );
    }

    const status = transitionChange(change.status, "merged");
    const [, merged] = await db.batch([
      db
        .update(repositories)
        .set({ headSha: result.sha })
        .where(eq(repositories.id, repository.id)),
      // Main has the merge now, whatever happened to the change meanwhile. A push
      // handled while git was merging moved the head: put it back on what merged.
      db
        .update(changes)
        .set({
          status,
          headSha: change.headSha,
          headRevisionId: change.headRevisionId,
          mergedAt: deps.clock.now(),
          mergedBy: user.id,
          mergeSha: result.sha,
        })
        .where(and(eq(changes.id, changeId), ne(changes.status, status)))
        .returning({ id: changes.id }),
    ]);
    if (merged.length > 0) {
      await emit(deps, changeId, { type: "change.merged", mergeSha: result.sha, userId: user.id });
      await emit(deps, changeId, { type: "change.status", status });
    }
  }

  // The session ends last, so a merge that died after it was recorded finishes here when repeated.
  if (session.status === "active") {
    await deps.decisions.settleChange(changeId);
    await endSession(deps, session.id, "merged");
  }
  return toChange(await requireChange(db, changeId));
}

/** Closes a change without merging and ends its session. */
export async function closeChange(
  deps: PipelineDeps,
  user: User,
  changeId: ChangeId,
): Promise<Change> {
  const { db } = deps;
  const change = await requireChange(db, changeId);
  if (!can(user, { type: "change.close", change })) {
    throw new ForgeError("forbidden", "Only the author or an administrator can close a change.");
  }
  if (change.status !== "closed") {
    if (!canTransitionChange(change.status, "closed")) {
      throw new ForgeError("conflict", `A ${change.status} change cannot be closed.`);
    }
    const status = transitionChange(change.status, "closed");
    const closed = await db
      .update(changes)
      .set({ status, closedAt: deps.clock.now() })
      .where(and(eq(changes.id, changeId), eq(changes.status, change.status)))
      .returning({ id: changes.id });
    if (closed.length > 0) await emit(deps, changeId, { type: "change.status", status });
  }
  await endSession(deps, change.sessionId, "abandoned");
  return toChange(await requireChange(db, changeId));
}

/**
 * Ends a session, in the one place that does: marks it merged or abandoned,
 * stops a hosted session's sandbox, deletes its fork from the git host (which
 * revokes the fork's tokens) and records that the fork is gone. `mergeChange`
 * and `closeChange` call it; so does abandoning a session that never opened a
 * change. Safe to call twice.
 */
export async function endSession(
  deps: Pick<PipelineDeps, "db" | "git" | "cloudSessions" | "clock">,
  sessionId: SessionId,
  outcome: "merged" | "abandoned",
): Promise<Session> {
  const { db } = deps;
  const session = await requireSession(db, sessionId);
  // A session ends once: a second call, even with the other outcome, only finishes the clean-up.
  if (session.status === "active") {
    await db
      .update(sessions)
      .set({ status: transitionSession(session.status, outcome), endedAt: deps.clock.now() })
      .where(and(eq(sessions.id, sessionId), eq(sessions.status, "active")));
  }
  if (session.forkDeletedAt === null) {
    // Before the fork goes, so the agent is not left pushing to a repository that is gone.
    // A sandbox stops more than once without complaint, which keeps this safe to repeat.
    if (session.kind === "cloud") await deps.cloudSessions.stop(sessionId);
    await deps.git.deleteRepo(session.forkRepo);
    const now = deps.clock.now();
    await db.batch([
      db.update(sessions).set({ forkDeletedAt: now }).where(eq(sessions.id, sessionId)),
      db
        .update(gitTokens)
        .set({ revokedAt: now })
        .where(and(eq(gitTokens.repoName, session.forkRepo), isNull(gitTokens.revokedAt))),
    ]);
  }
  return requireSession(db, sessionId);
}
