import type { Approval, ApprovalWithdrawalReason, Section } from "../domain/section";
import type { ApprovalId, SectionId } from "../ids";

/** An approval counts while it has not been withdrawn and the section still has the content it approved. */
export function isApprovalCurrent(approval: Approval, section: Section): boolean {
  return (
    approval.sectionId === section.id &&
    approval.withdrawnAt === null &&
    approval.contentHash === section.contentHash
  );
}

/**
 * `approved`   at least one current approval
 * `withdrawn`  it was approved, and a later commit or the approver took that away
 * `pending`    nobody has approved it yet
 */
export type SectionApprovalState = "approved" | "withdrawn" | "pending";

export function sectionApprovalState(
  section: Section,
  approvals: readonly Approval[],
): SectionApprovalState {
  const own = approvals.filter((a) => a.sectionId === section.id);
  if (own.some((a) => isApprovalCurrent(a, section))) return "approved";
  return own.length > 0 ? "withdrawn" : "pending";
}

export interface ApprovalWithdrawal {
  approvalId: ApprovalId;
  sectionId: SectionId;
  reason: ApprovalWithdrawalReason;
}

/**
 * What a new commit withdraws. Called with the sections as they stand after
 * the push was folded in: an approval is withdrawn only if its own section's
 * content changed or the section is gone. Approvals of untouched sections
 * stay, which is the point of keeping sections stable across pushes.
 */
export function approvalsWithdrawnByPush(
  sectionsAfter: readonly Section[],
  approvals: readonly Approval[],
): ApprovalWithdrawal[] {
  const byId = new Map(sectionsAfter.map((s) => [s.id, s]));
  const withdrawals: ApprovalWithdrawal[] = [];
  for (const approval of approvals) {
    if (approval.withdrawnAt !== null) continue;
    const section = byId.get(approval.sectionId);
    if (!section) {
      withdrawals.push({
        approvalId: approval.id,
        sectionId: approval.sectionId,
        reason: "section_removed",
      });
    } else if (section.contentHash !== approval.contentHash) {
      withdrawals.push({
        approvalId: approval.id,
        sectionId: approval.sectionId,
        reason: "content_changed",
      });
    }
  }
  return withdrawals;
}

/** A person approves a section once per content; approving again after it changed is a new approval. */
export function canApprove(
  section: Section,
  approvals: readonly Approval[],
  userId: Approval["userId"],
): boolean {
  return !approvals.some((a) => a.userId === userId && isApprovalCurrent(a, section));
}
