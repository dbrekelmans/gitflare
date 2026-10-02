import type { SectionView } from "@gitflare/core/api";
import { demo, demoUsers } from "@gitflare/testing/demo";
import { describe, expect, it } from "vitest";
import { approvalCopy, approvalStatusCopy, mergedCopy, plural } from "./copy";

const section = demo.sections[0] as SectionView["section"];
const approval = (
  over: Partial<SectionView["approvals"][number]>,
): SectionView["approvals"][number] => ({
  id: "apr_1" as SectionView["approvals"][number]["id"],
  changeId: section.changeId,
  sectionId: section.id,
  userId: demoUsers.priya.id,
  user: demoUsers.priya,
  contentHash: section.contentHash,
  selfApproval: false,
  createdAt: 0,
  withdrawnAt: null,
  withdrawnReason: null,
  ...over,
});

describe("plural", () => {
  it("takes the plural it is given where an s does not make one", () => {
    expect(plural(2, "push", "pushes")).toBe("2 pushes");
    expect(plural(1, "push", "pushes")).toBe("1 push");
    expect(plural(3, "commit")).toBe("3 commits");
  });
});

describe("an approval in the history", () => {
  it("is of an earlier version only when a later push made it stale", () => {
    const stale = approval({ withdrawnAt: 1, withdrawnReason: "content_changed" });
    expect(approvalCopy(stale, false)).toBe("Priya Raman approved an earlier version");
    expect(approvalCopy({ ...stale, selfApproval: true }, false)).toBe(
      "Priya Raman approved an earlier version of their own change",
    );
  });

  it("taken back by the approver, was of the version it names", () => {
    const revoked = approval({ withdrawnAt: 1, withdrawnReason: "revoked" });
    expect(approvalCopy(revoked, false)).toBe("Priya Raman approved");
    expect(approvalCopy({ ...revoked, selfApproval: true }, false)).toBe(
      "Priya Raman approved their own change",
    );
  });

  it("whose section was removed, was of the version it names", () => {
    const removed = approval({ withdrawnAt: 1, withdrawnReason: "section_removed" });
    expect(approvalCopy(removed, false)).toBe("Priya Raman approved");
  });
});

describe("a section's approval status", () => {
  it("is never self-approved with no current approval in hand", () => {
    expect(approvalStatusCopy({ approvalState: "approved", approvals: [], section }).label).toBe(
      "Approved",
    );
  });

  it("is self-approved when every current approval is the author's", () => {
    const view = { approvalState: "approved" as const, section };
    expect(
      approvalStatusCopy({ ...view, approvals: [approval({ selfApproval: true })] }).label,
    ).toBe("Approved by its author");
    expect(
      approvalStatusCopy({
        ...view,
        approvals: [approval({ selfApproval: true }), approval({ id: "apr_2" as never })],
      }).label,
    ).toBe("Approved");
  });
});

describe("a merge", () => {
  it("names who merged it and when, or what is known of that", () => {
    expect(mergedCopy({ name: "Maya Okafor" }, null)).toBe("Merged by Maya Okafor.");
    expect(mergedCopy(null, null)).toBe("Merged.");
    expect(mergedCopy({ name: "Maya Okafor" }, "1 Oct, 10:58 UTC")).toBe(
      "Merged by Maya Okafor, 1 Oct, 10:58 UTC.",
    );
  });
});
