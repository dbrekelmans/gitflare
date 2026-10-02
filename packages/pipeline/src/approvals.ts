import {
  type Approval,
  type ChangeId,
  can,
  ForgeError,
  isApprovalCurrent,
  type Section,
  type SectionId,
  type StageName,
  type StageRun,
  type User,
} from "@gitflare/core";
import { type Db, schema, toSection } from "@gitflare/db";
import { and, eq, isNull } from "drizzle-orm";
import { type ChangeRow, emit, headStageRuns, type PipelineDeps, requireChange } from "./deps";
import { queueStageRerun } from "./stages";

const { approvals, sections } = schema;

type ApprovalDeps = Pick<PipelineDeps, "db" | "live" | "clock" | "ids">;

function requireReviewer(user: User): void {
  if (!can(user, { type: "change.review" })) {
    throw new ForgeError("forbidden", "You are not allowed to review changes.");
  }
}

async function reviewable(
  db: Db,
  changeId: ChangeId,
  sectionId: SectionId,
): Promise<{ change: ChangeRow; section: Section; given: Approval[] }> {
  const change = await requireChange(db, changeId);
  if (change.status === "merged" || change.status === "closed") {
    throw new ForgeError("conflict", `A ${change.status} change is no longer under review.`);
  }
  const [row] = await db
    .select()
    .from(sections)
    .where(
      and(eq(sections.id, sectionId), eq(sections.changeId, changeId), isNull(sections.removedAt)),
    );
  if (!row) throw new ForgeError("not_found", "Section not found.");
  const given = await db.select().from(approvals).where(eq(approvals.sectionId, sectionId));
  return { change, section: toSection(row), given };
}

/**
 * Records the caller's approval of a section as it stands. An author may
 * approve their own change; that is stored as a self-approval. Approving what
 * the caller already approved changes nothing.
 */
export async function approveSection(
  deps: ApprovalDeps,
  user: User,
  changeId: ChangeId,
  sectionId: SectionId,
): Promise<Approval> {
  requireReviewer(user);
  const { change, section, given } = await reviewable(deps.db, changeId, sectionId);
  const standing = given.find((a) => a.userId === user.id && isApprovalCurrent(a, section));
  if (standing) return standing;

  const approval: Approval = {
    id: deps.ids.next("approval"),
    changeId,
    sectionId,
    userId: user.id,
    selfApproval: change.authorId === user.id,
    contentHash: section.contentHash,
    createdAt: deps.clock.now(),
    withdrawnAt: null,
    withdrawnReason: null,
  };
  await deps.db.insert(approvals).values(approval);
  await emit(deps, changeId, { type: "section.approved", sectionId, userId: user.id });
  return approval;
}

/** Withdraws the caller's own current approval of a section, if they have one. */
export async function revokeApproval(
  deps: ApprovalDeps,
  user: User,
  changeId: ChangeId,
  sectionId: SectionId,
): Promise<void> {
  requireReviewer(user);
  const { section, given } = await reviewable(deps.db, changeId, sectionId);
  for (const approval of given) {
    if (approval.userId !== user.id || !isApprovalCurrent(approval, section)) continue;
    await deps.db
      .update(approvals)
      .set({ withdrawnAt: deps.clock.now(), withdrawnReason: "revoked" })
      .where(and(eq(approvals.id, approval.id), isNull(approvals.withdrawnAt)));
    await emit(deps, changeId, {
      type: "section.approval_withdrawn",
      sectionId,
      userId: user.id,
    });
  }
}

/**
 * A person asking for a stage to run again: queues the attempt at once, so
 * the change shows it, and hands the running of it to the pipeline. One
 * queued and never picked up is handed over again.
 *
 * A stage that is still running is a `conflict`, but it is handed over too:
 * if the Workflow running it died, that is what starts it again, and if not,
 * the pipeline does nothing.
 */
export async function rerunStage(
  deps: PipelineDeps,
  user: User,
  changeId: ChangeId,
  stage: StageName,
): Promise<StageRun> {
  requireReviewer(user);
  const change = await requireChange(deps.db, changeId);
  const latest = (await headStageRuns(deps.db, change.headRevisionId)).find(
    (run) => run.stage === stage,
  );
  if (latest?.status === "running") {
    await deps.pipeline.rerunStage(changeId, stage, latest.attempt);
    throw new ForgeError("conflict", `The ${stage} stage is already running.`);
  }
  const run = await queueStageRerun(deps, changeId, stage);
  await deps.pipeline.rerunStage(changeId, stage, run.attempt);
  return run;
}
