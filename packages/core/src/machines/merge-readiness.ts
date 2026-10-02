import type { Change, StageRun, StageStatus } from "../domain/change";
import type { Approval, Section } from "../domain/section";
import type { Thread } from "../domain/thread";
import type { SectionId, ThreadId } from "../ids";
import { sectionApprovalState } from "./approval";
import { latestStageRuns } from "./change-status";

export type MergeBlocker =
  /** The change is still open or processing, or already merged or closed. */
  | { kind: "status"; status: Change["status"] }
  /** Sectioning has not produced anything to approve. */
  | { kind: "no_sections" }
  | { kind: "sections_unapproved"; sectionIds: SectionId[] }
  | { kind: "comments_open"; threadIds: ThreadId[] }
  /** CI failed, or has not produced a result for the head revision. */
  | { kind: "ci_not_green"; status: StageStatus | "missing" };

export interface MergeReadiness {
  ready: boolean;
  blockers: MergeBlocker[];
}

/**
 * A change may merge when every section has a current approval, every comment
 * is resolved or dismissed, and CI is green. Chats never block. A CI stage that
 * was skipped because the repository has no CI configured counts as green: the
 * reviewer sees that it was skipped, and nothing can turn it green.
 *
 * A failed intent, sectioning or review stage does not block by name. Failed
 * sectioning blocks anyway, because there is then nothing to approve.
 */
export function mergeReadiness(input: {
  change: Pick<Change, "status">;
  /** Stage runs of the head revision. */
  headStageRuns: readonly StageRun[];
  sections: readonly Section[];
  approvals: readonly Approval[];
  threads: readonly Thread[];
}): MergeReadiness {
  const blockers: MergeBlocker[] = [];

  if (input.change.status !== "ready") {
    blockers.push({ kind: "status", status: input.change.status });
  }

  if (input.sections.length === 0) {
    blockers.push({ kind: "no_sections" });
  } else {
    const unapproved = input.sections
      .filter((section) => sectionApprovalState(section, input.approvals) !== "approved")
      .map((section) => section.id);
    if (unapproved.length > 0)
      blockers.push({ kind: "sections_unapproved", sectionIds: unapproved });
  }

  const openComments = input.threads
    .filter((thread) => thread.kind === "comment" && thread.status === "open")
    .map((thread) => thread.id);
  if (openComments.length > 0) blockers.push({ kind: "comments_open", threadIds: openComments });

  const ci = latestStageRuns(input.headStageRuns).ci;
  if (!ci) {
    blockers.push({ kind: "ci_not_green", status: "missing" });
  } else if (ci.status !== "succeeded" && ci.status !== "skipped") {
    blockers.push({ kind: "ci_not_green", status: ci.status });
  }

  return { ready: blockers.length === 0, blockers };
}
