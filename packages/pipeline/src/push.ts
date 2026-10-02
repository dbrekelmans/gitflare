import {
  type ChangeId,
  canTransitionChange,
  classifyPush,
  type GitCommit,
  type Push,
  type PushKind,
  parseCheckpointTrailers,
  type Revision,
  type RevisionId,
  type Sha,
  type StageRun,
  stageNames,
  transitionChange,
} from "@gitflare/core";
import type { GitHost } from "@gitflare/core/ports";
import { fromRevision, schema } from "@gitflare/db";
import { and, eq, inArray, max, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import {
  type ChangeRow,
  chunks,
  commit,
  emit,
  headStageRuns,
  type PipelineDeps,
  type SessionRow,
} from "./deps";

const { changes, changeCommits, repositories, revisions, sessions, stageRuns } = schema;

export type PushResult =
  /** The push opened a change or added a revision; its stages are queued. */
  | {
      kind: "change";
      changeId: ChangeId;
      revisionId: RevisionId;
      opened: boolean;
      stages: StageRun[];
    }
  | { kind: "checkpoint"; checkpointId: string }
  | { kind: "ignored"; reason: string };

const ignored = (reason: string): PushResult => ({ kind: "ignored", reason });

const LOG_PAGE = 50;
/** A change with more commits than this lists its newest ones. */
const MAX_COMMITS = 500;

/**
 * Reacts to one push. For a session's branch it re-reads the commit range
 * from the fork (the event's own commit list can be truncated), opens the
 * change or adds a revision (filling each commit's `checkpointIds` with
 * `parseCheckpointTrailers`), and creates the head revision's stage runs. For
 * a checkpoint ref it records the new tip. Events come one per ref and can
 * arrive out of order, so this reads the ref's current tip rather than trust
 * the event's `after`, and the same or an older push delivered again yields
 * the same result.
 */
export async function handlePush(deps: PipelineDeps, push: Push): Promise<PushResult> {
  const kind = classifyPush(push);
  if (kind.kind === "ignored") return kind;
  if (kind.kind === "checkpoint") {
    const [repository] = await deps.db
      .select({ id: repositories.id })
      .from(repositories)
      .where(eq(repositories.slug, kind.slug));
    if (!repository) return ignored("no repository owns this context repo");
    await deps.capture.recordCheckpoint(repository.id, kind.checkpointId, push);
    return { kind: "checkpoint", checkpointId: kind.checkpointId };
  }
  return handleBranchPush(deps, kind, push);
}

async function handleBranchPush(
  deps: PipelineDeps,
  kind: Extract<PushKind, { kind: "change" }>,
  push: Push,
): Promise<PushResult> {
  const { db } = deps;
  const [session] = await db.select().from(sessions).where(eq(sessions.id, kind.sessionId));
  if (!session) return ignored("no session owns this fork");
  if (session.status !== "active") return ignored("the session has ended");

  const [change] = await db.select().from(changes).where(eq(changes.sessionId, session.id));
  if (change && change.headRef !== push.ref) {
    return ignored("the session's change tracks another branch");
  }
  if (change && !canTransitionChange(change.status, "revision_pushed")) {
    return ignored(`the change is ${change.status}`);
  }

  const tip = await deps.git.resolveRef(session.forkRepo, kind.branch);
  if (!tip) return ignored("the branch has no tip to read");

  if (change) {
    const [known] = await db
      .select()
      .from(revisions)
      .where(and(eq(revisions.changeId, change.id), eq(revisions.headSha, tip)));
    if (known?.id === change.headRevisionId) return unchanged(deps, change);
    // The branch was moved back to a head it had before.
    if (known) return moveHead(deps, change, known, []);
  }

  const baseSha = change?.baseSha ?? session.baseSha;
  const commits = await commitRange(deps.git, session.forkRepo, tip, baseSha);
  if (commits.length === 0) return ignored("the branch has no commits beyond its base");
  const diff = await deps.diffs.between(session.forkRepo, baseSha, tip);

  const changeId = change?.id ?? deps.ids.next("change");
  const revision: Revision = {
    id: deps.ids.next("revision"),
    changeId,
    number: change ? (await lastRevisionNumber(deps, change.id)) + 1 : 1,
    baseSha,
    headSha: tip,
    pushedAt: deps.clock.now(),
    stats: {
      commits: commits.length,
      filesChanged: diff.length,
      insertions: diff.reduce((sum, file) => sum + file.insertions, 0),
      deletions: diff.reduce((sum, file) => sum + file.deletions, 0),
    },
  };
  const commitRows = commits.map((entry, position) => ({
    changeId,
    sha: entry.sha,
    revisionId: revision.id,
    position,
    message: entry.message,
    authorName: entry.author.name,
    authorEmail: entry.author.email,
    authoredAt: entry.authoredAt,
    checkpointIds: parseCheckpointTrailers(entry.message),
  }));
  const records: BatchItem<"sqlite">[] = [
    db.insert(revisions).values(fromRevision(revision)),
    // A commit belongs to the revision that first brought it.
    ...chunks(commitRows).map((rows) =>
      db.insert(changeCommits).values(rows).onConflictDoNothing(),
    ),
  ];

  try {
    if (change) return await moveHead(deps, change, revision, records);
    return await openChange(deps, session, push.ref, revision, records);
  } catch (error) {
    // The same push handled twice at once: the other one's rows are the result.
    const [winner] = await db.select().from(changes).where(eq(changes.sessionId, session.id));
    if (winner?.headSha === tip) return unchanged(deps, winner);
    throw error;
  }
}

async function unchanged(deps: PipelineDeps, change: ChangeRow): Promise<PushResult> {
  return {
    kind: "change",
    changeId: change.id,
    revisionId: change.headRevisionId,
    opened: false,
    stages: await headStageRuns(deps.db, change.headRevisionId),
  };
}

async function openChange(
  deps: PipelineDeps,
  session: SessionRow,
  headRef: string,
  revision: Revision,
  records: BatchItem<"sqlite">[],
): Promise<PushResult> {
  const { db } = deps;
  const stages = queuedRuns(deps, revision, []);
  // The stage runs are created with the change, so it is never seen without them.
  const status = transitionChange("open", "pipeline_started");
  await commit(db, [
    db
      .update(repositories)
      .set({ nextChangeNumber: sql`${repositories.nextChangeNumber} + 1` })
      .where(eq(repositories.id, session.repositoryId)),
    db.insert(changes).values({
      id: revision.changeId,
      repositoryId: session.repositoryId,
      sessionId: session.id,
      number: sql`(select ${repositories.nextChangeNumber} - 1 from ${repositories} where ${repositories.id} = ${session.repositoryId})`,
      title: session.title,
      status,
      authorId: session.userId,
      headRef,
      baseSha: revision.baseSha,
      headSha: revision.headSha,
      headRevisionId: revision.id,
      openedAt: revision.pushedAt,
    }),
    ...records,
    db.insert(stageRuns).values(stages),
  ]);
  await emit(deps, revision.changeId, { type: "change.status", status });
  return {
    kind: "change",
    changeId: revision.changeId,
    revisionId: revision.id,
    opened: true,
    stages,
  };
}

/** Makes `revision` the change's head and queues a fresh attempt of every stage for it. */
async function moveHead(
  deps: PipelineDeps,
  change: ChangeRow,
  revision: Pick<Revision, "id" | "changeId" | "number" | "headSha">,
  records: BatchItem<"sqlite">[],
): Promise<PushResult> {
  const { db } = deps;
  const earlier = await db.select().from(stageRuns).where(eq(stageRuns.revisionId, revision.id));
  const stages = queuedRuns(deps, revision, earlier);
  const status = transitionChange(
    transitionChange(change.status, "revision_pushed"),
    "pipeline_started",
  );
  await commit(db, [
    ...records,
    db.insert(stageRuns).values(stages),
    db
      .update(changes)
      .set({ headSha: revision.headSha, headRevisionId: revision.id, status, readyAt: null })
      .where(
        and(eq(changes.id, change.id), inArray(changes.status, ["open", "processing", "ready"])),
      ),
  ]);
  await emit(deps, change.id, {
    type: "revision.pushed",
    revisionId: revision.id,
    number: revision.number,
  });
  await emit(deps, change.id, { type: "change.status", status });
  return { kind: "change", changeId: change.id, revisionId: revision.id, opened: false, stages };
}

function queuedRuns(
  deps: Pick<PipelineDeps, "ids">,
  revision: Pick<Revision, "id" | "changeId">,
  earlier: readonly StageRun[],
): StageRun[] {
  return stageNames.map((stage) => ({
    id: deps.ids.next("stageRun"),
    changeId: revision.changeId,
    revisionId: revision.id,
    stage,
    attempt: Math.max(0, ...earlier.filter((run) => run.stage === stage).map((r) => r.attempt)) + 1,
    status: "queued",
    reason: null,
    startedAt: null,
    finishedAt: null,
  }));
}

async function lastRevisionNumber(deps: PipelineDeps, changeId: ChangeId): Promise<number> {
  const [row] = await deps.db
    .select({ number: max(revisions.number) })
    .from(revisions)
    .where(eq(revisions.changeId, changeId));
  return row?.number ?? 0;
}

/**
 * The commits from `base` (exclusive) to `tip`, oldest first, by first parent.
 * A base that is not on the first-parent line is never reached, and the walk
 * then stops at the root or at `MAX_COMMITS`.
 */
async function commitRange(git: GitHost, repo: string, tip: Sha, base: Sha): Promise<GitCommit[]> {
  const range: GitCommit[] = [];
  for (let offset = 0; offset < MAX_COMMITS; offset += LOG_PAGE) {
    const page = await git.log(repo, { ref: tip, limit: LOG_PAGE, offset });
    for (const entry of page) {
      if (entry.sha === base) return range.reverse();
      range.push(entry);
    }
    if (page.length < LOG_PAGE) break;
  }
  return range.reverse();
}
