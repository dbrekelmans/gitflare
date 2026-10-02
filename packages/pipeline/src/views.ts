import {
  type Approval,
  type ChangeId,
  captureState,
  type FileDiff,
  ForgeError,
  isApprovalCurrent,
  mainRepoName,
  mergeReadiness,
  type Section,
  type SectionId,
  type StageRun,
  sectionApprovalState,
  selectDiff,
  type Thread,
  type User,
} from "@gitflare/core";
import type {
  CaptureSummary,
  ChangeDetail,
  ChangeSummary,
  CiView,
  ListChangesInput,
  SectionDiff,
  SectionView,
  UserRef,
} from "@gitflare/core/api";
import {
  changeCost,
  type Db,
  schema,
  toChange,
  toChangeCommit,
  toRevision,
  toSection,
} from "@gitflare/db";
import { and, desc, eq, inArray, isNull, ne } from "drizzle-orm";
import type { z } from "zod";
import {
  type ChangeRow,
  latestInStageOrder,
  type PipelineDeps,
  requireChange,
  requireSession,
  type SessionRow,
} from "./deps";
import { CHECKPOINT_WAIT_MS, missingCheckpoints } from "./stages";

const {
  approvals,
  capturedSessions,
  changeCommits,
  changes,
  ciRuns,
  ciSteps,
  intents,
  repositories,
  revisions,
  sections,
  stageRuns,
  threads,
  users,
} = schema;

type ViewDeps = Pick<PipelineDeps, "db" | "diffs" | "capture" | "clock">;
type RepositoryRow = typeof repositories.$inferSelect;

const isOpenComment = (thread: Thread) => thread.kind === "comment" && thread.status === "open";

async function userRefs(db: Db): Promise<(id: User["id"]) => UserRef> {
  // One deployment is one organisation: everyone fits in a single read.
  const rows = await db.select({ id: users.id, name: users.name, email: users.email }).from(users);
  const byId = new Map(rows.map((row) => [row.id, row]));
  return (id) => {
    const user = byId.get(id);
    if (!user) throw new ForgeError("not_found", "User not found.");
    return user;
  };
}

async function requireRepository(db: Db, change: ChangeRow): Promise<RepositoryRow> {
  const [row] = await db
    .select()
    .from(repositories)
    .where(eq(repositories.id, change.repositoryId));
  if (!row) throw new ForgeError("not_found", "Repository not found.");
  return row;
}

/**
 * Where the change's commits can still be read: its fork while that exists,
 * the main repo once it merged. An abandoned change's diff went with its fork.
 */
function readableRepo(
  change: ChangeRow,
  session: SessionRow,
  repository: RepositoryRow,
): string | null {
  if (session.forkDeletedAt === null) return session.forkRepo;
  return change.status === "merged" ? mainRepoName(repository.slug) : null;
}

async function changeDiff(
  deps: Pick<ViewDeps, "db" | "diffs">,
  change: ChangeRow,
  session: SessionRow,
): Promise<FileDiff[] | null> {
  const repo = readableRepo(change, session, await requireRepository(deps.db, change));
  return repo ? deps.diffs.between(repo, change.baseSha, change.headSha) : null;
}

/** The change page's read model. */
export async function changeDetail(deps: ViewDeps, changeId: ChangeId): Promise<ChangeDetail> {
  const { db } = deps;
  const row = await requireChange(db, changeId);
  const change = toChange(row);
  const [
    repository,
    session,
    ref,
    revisionRows,
    commitRows,
    runs,
    intentRows,
    sectionRows,
    given,
    threadRows,
    captured,
    cost,
  ] = await Promise.all([
    requireRepository(db, row),
    requireSession(db, row.sessionId),
    userRefs(db),
    db.select().from(revisions).where(eq(revisions.changeId, changeId)).orderBy(revisions.number),
    db
      .select()
      .from(changeCommits)
      .where(eq(changeCommits.changeId, changeId))
      .orderBy(changeCommits.position),
    db.select().from(stageRuns).where(eq(stageRuns.revisionId, row.headRevisionId)),
    db
      .select()
      .from(intents)
      .where(eq(intents.changeId, changeId))
      .orderBy(desc(intents.version))
      .limit(1),
    db
      .select()
      .from(sections)
      .where(and(eq(sections.changeId, changeId), isNull(sections.removedAt)))
      .orderBy(sections.position),
    db.select().from(approvals).where(eq(approvals.changeId, changeId)),
    db.select().from(threads).where(eq(threads.changeId, changeId)).orderBy(threads.createdAt),
    db.select().from(capturedSessions).where(eq(capturedSessions.changeId, changeId)),
    changeCost(db, changeId),
  ]);

  const stages = latestInStageOrder(runs);
  const current = sectionRows.map(toSection);
  const diff = current.length > 0 ? ((await changeDiff(deps, row, session)) ?? []) : [];
  const headRevision = revisionRows.find((revision) => revision.id === row.headRevisionId);
  const commits = commitRows.map(toChangeCommit);

  const sectionView = (section: Section): SectionView => {
    const own = given.filter((approval) => approval.sectionId === section.id);
    const files = selectDiff(diff, section.files);
    return {
      section,
      approvalState: sectionApprovalState(section, own),
      approvals: own
        .sort((a, b) => b.createdAt - a.createdAt)
        .map((approval) => ({ ...approval, user: ref(approval.userId) })),
      filesChanged: files.length,
      insertions: files.reduce((sum, file) => sum + file.insertions, 0),
      deletions: files.reduce((sum, file) => sum + file.deletions, 0),
      openComments: threadRows.filter((t) => t.sectionId === section.id && isOpenComment(t)).length,
    };
  };

  // The wait for checkpoints ends when the stages start, or when its minute is up.
  const waiting =
    (row.status === "open" || row.status === "processing") &&
    stages.every((run) => run.status === "queued") &&
    deps.clock.now() - (headRevision?.pushedAt ?? 0) < CHECKPOINT_WAIT_MS;

  return {
    change,
    repository: { id: repository.id, slug: repository.slug },
    author: ref(change.authorId),
    mergedBy: change.mergedBy ? ref(change.mergedBy) : null,
    session,
    capture: await captureSummary(deps, changeId, commits, captured, waiting),
    revisions: revisionRows.map(toRevision),
    commits,
    stages,
    intent: intentRows[0] ?? null,
    sections: current.map(sectionView),
    readiness: mergeReadiness({
      change,
      headStageRuns: stages,
      sections: current,
      approvals: given,
      threads: threadRows,
    }),
    cost,
    lastEventSeq: row.lastEventSeq,
  };
}

async function captureSummary(
  deps: Pick<ViewDeps, "db" | "capture">,
  changeId: ChangeId,
  commits: { checkpointIds: string[] }[],
  captured: (typeof capturedSessions.$inferSelect)[],
  waiting: boolean,
): Promise<CaptureSummary> {
  const named = [...new Set(commits.flatMap((entry) => entry.checkpointIds))];
  const missing = await missingCheckpoints(deps, changeId);
  return {
    state: captureState({ named, arrived: named.filter((id) => !missing.includes(id)), waiting }),
    sessions: captured.map(({ agentSessionId, agent, model, checkpointIds, attribution }) => ({
      agentSessionId,
      agent,
      model,
      checkpointIds,
      attribution,
    })),
    missingCheckpointIds: missing,
  };
}

/** The changes a caller can see, newest first, narrowed to a repository, statuses or a scope. */
export async function listChanges(
  deps: Pick<ViewDeps, "db">,
  user: User,
  input: z.output<typeof ListChangesInput>,
): Promise<ChangeSummary[]> {
  const { db } = deps;
  const repositoryRows = await db
    .select({ id: repositories.id, slug: repositories.slug })
    .from(repositories);
  const repository = repositoryRows.find((row) => row.slug === input.repoSlug);
  if (input.repoSlug && !repository) throw new ForgeError("not_found", "Repository not found.");

  const filter = and(
    repository && eq(changes.repositoryId, repository.id),
    input.statuses && inArray(changes.status, input.statuses),
    input.scope === "mine" ? eq(changes.authorId, user.id) : undefined,
    // The rest of what makes a change wait on the caller is decided per section, below.
    input.scope === "inbox"
      ? and(eq(changes.status, "ready"), ne(changes.authorId, user.id))
      : undefined,
  );
  const matching = db.select({ id: changes.id }).from(changes).where(filter);
  const [rows, ref, runs, sectionRows, given, threadRows] = await Promise.all([
    db.select().from(changes).where(filter).orderBy(desc(changes.openedAt), desc(changes.id)),
    userRefs(db),
    db
      .select()
      .from(stageRuns)
      .where(
        inArray(
          stageRuns.revisionId,
          db.select({ id: changes.headRevisionId }).from(changes).where(filter),
        ),
      ),
    db
      .select()
      .from(sections)
      .where(and(inArray(sections.changeId, matching), isNull(sections.removedAt))),
    db.select().from(approvals).where(inArray(approvals.changeId, matching)),
    db.select().from(threads).where(inArray(threads.changeId, matching)),
  ]);

  const of = <T extends { changeId: ChangeId }>(all: T[], changeId: ChangeId) =>
    all.filter((item) => item.changeId === changeId);

  const summaries = rows.map((row): ChangeSummary => {
    const current = of(sectionRows, row.id).map(toSection);
    const own: Approval[] = of(given, row.id);
    const repo = repositoryRows.find((candidate) => candidate.id === row.repositoryId);
    if (!repo) throw new ForgeError("not_found", "Repository not found.");
    const waitsOnCaller = current.some(
      (section) => !own.some((a) => a.userId === user.id && isApprovalCurrent(a, section)),
    );
    return {
      change: toChange(row),
      repository: repo,
      author: ref(row.authorId),
      stages: latestInStageOrder(of<StageRun>(runs, row.id)),
      sectionsTotal: current.length,
      sectionsApproved: current.filter((s) => sectionApprovalState(s, own) === "approved").length,
      openComments: of<Thread>(threadRows, row.id).filter(isOpenComment).length,
      needsYou: row.status === "ready" && row.authorId !== user.id && waitsOnCaller,
    };
  });
  return input.scope === "inbox" ? summaries.filter((summary) => summary.needsYou) : summaries;
}

/** The part of the change's diff one section presents, at the change's head. */
export async function sectionDiff(
  deps: Pick<ViewDeps, "db" | "diffs">,
  changeId: ChangeId,
  sectionId: SectionId,
): Promise<SectionDiff> {
  const { db } = deps;
  const change = await requireChange(db, changeId);
  const [section] = await db
    .select()
    .from(sections)
    .where(and(eq(sections.id, sectionId), eq(sections.changeId, changeId)));
  if (!section) throw new ForgeError("not_found", "Section not found.");
  const diff = await changeDiff(deps, change, await requireSession(db, change.sessionId));
  if (!diff) {
    throw new ForgeError(
      "not_found",
      "This change was closed and its fork deleted: the diff is no longer available.",
    );
  }
  return { changeId, sectionId, files: selectDiff(diff, section.files) };
}

/** The CI run of the head revision's newest CI attempt, with its steps in order. */
export async function ciView(deps: Pick<ViewDeps, "db">, changeId: ChangeId): Promise<CiView> {
  const { db } = deps;
  const change = await requireChange(db, changeId);
  const attempts = await db
    .select()
    .from(stageRuns)
    .where(and(eq(stageRuns.revisionId, change.headRevisionId), eq(stageRuns.stage, "ci")));
  const [attempt] = latestInStageOrder(attempts);
  if (!attempt) return { run: null, steps: [] };
  const [row] = await db.select().from(ciRuns).where(eq(ciRuns.stageRunId, attempt.id));
  if (!row) return { run: null, steps: [] };
  const { stageRunId: _stageRunId, ...run } = row;
  const steps = await db
    .select()
    .from(ciSteps)
    .where(eq(ciSteps.runId, run.id))
    .orderBy(ciSteps.position);
  return { run, steps };
}
