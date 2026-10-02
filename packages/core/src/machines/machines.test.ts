import { describe, expect, it } from "vitest";
import type { Change, StageName, StageRun, StageStatus } from "../domain/change";
import type { Approval, Section } from "../domain/section";
import type { Thread } from "../domain/thread";
import { workspaceStart } from "../ports/sandbox";
import { approvalsWithdrawnByPush, canApprove, sectionApprovalState } from "./approval";
import {
  canRerunStage,
  deriveChangeStatus,
  InvalidTransitionError,
  stagesSettled,
  transitionChange,
  transitionStage,
} from "./change-status";
import { applyDecisionEvent, decisionStrength, initialDecisionState } from "./decision-strength";
import { mergeReadiness } from "./merge-readiness";
import { sectionForAnchor, transitionSession, transitionThread } from "./thread";

function stage(name: StageName, status: StageStatus, attempt = 1): StageRun {
  return {
    id: `stg_${name}${attempt}`,
    changeId: "chg_1",
    revisionId: "rev_1",
    stage: name,
    attempt,
    status,
    reason: null,
    startedAt: null,
    finishedAt: null,
  };
}

function section(id: string, contentHash: string, position = 0, paths = ["a.ts"]): Section {
  return {
    id: `sec_${id}`,
    changeId: "chg_1",
    position,
    title: id,
    kind: "behaviour",
    explanation: "",
    files: paths.map((path) => ({ path, hunkHashes: [] })),
    contentHash,
    createdRevisionId: "rev_1",
    updatedRevisionId: "rev_1",
  };
}

function approval(id: string, sectionId: string, contentHash: string, userId = "usr_a"): Approval {
  return {
    id: `apr_${id}`,
    changeId: "chg_1",
    sectionId: `sec_${sectionId}`,
    userId: userId as Approval["userId"],
    selfApproval: false,
    contentHash,
    createdAt: 1,
    withdrawnAt: null,
    withdrawnReason: null,
  };
}

function thread(id: string, overrides: Partial<Thread> = {}): Thread {
  return {
    id: `thr_${id}`,
    changeId: "chg_1",
    sectionId: null,
    kind: "comment",
    origin: "review",
    status: "open",
    finding: null,
    anchor: null,
    anchorRevisionId: null,
    dismissal: null,
    decisionId: null,
    createdBy: null,
    createdAt: 1,
    settledAt: null,
    settledBy: null,
    learnedAt: null,
    messageCount: 1,
    lastMessageAt: 1,
    ...overrides,
  };
}

const allSucceeded = [
  stage("intent", "succeeded"),
  stage("sections", "succeeded"),
  stage("review", "succeeded"),
  stage("ci", "succeeded"),
];

describe("stage status", () => {
  it("runs queued → running → succeeded", () => {
    expect(transitionStage(transitionStage("queued", "start"), "succeed")).toBe("succeeded");
  });

  it("never changes a settled attempt", () => {
    for (const status of ["succeeded", "failed", "skipped"] as const) {
      expect(() => transitionStage(status, "start")).toThrow(InvalidTransitionError);
      expect(canRerunStage(status)).toBe(true);
    }
    expect(canRerunStage("running")).toBe(false);
  });

  it("judges settledness by the newest attempt of each stage", () => {
    expect(stagesSettled(allSucceeded)).toBe(true);
    expect(stagesSettled(allSucceeded.slice(0, 3))).toBe(false);
    expect(stagesSettled([...allSucceeded, stage("ci", "running", 2)])).toBe(false);
    expect(stagesSettled([stage("ci", "failed"), ...allSucceeded.slice(0, 3)])).toBe(true);
  });
});

describe("change status", () => {
  it("follows open → processing → ready → merged", () => {
    let status: Change["status"] = "open";
    status = transitionChange(status, "pipeline_started");
    expect(status).toBe("processing");
    status = transitionChange(status, "stages_settled");
    expect(status).toBe("ready");
    expect(transitionChange(status, "merged")).toBe("merged");
  });

  it("goes back to open on a new push and to processing on a re-run", () => {
    expect(transitionChange("ready", "revision_pushed")).toBe("open");
    expect(transitionChange("processing", "revision_pushed")).toBe("open");
    expect(transitionChange("ready", "stage_rerun")).toBe("processing");
  });

  it("only merges from ready, and nothing leaves merged or closed", () => {
    expect(() => transitionChange("processing", "merged")).toThrow(InvalidTransitionError);
    expect(() => transitionChange("open", "merged")).toThrow(InvalidTransitionError);
    expect(() => transitionChange("merged", "revision_pushed")).toThrow(InvalidTransitionError);
    expect(() => transitionChange("closed", "stage_rerun")).toThrow(InvalidTransitionError);
  });

  it("is ready when a stage failed: a failure never hides the change", () => {
    const runs = [stage("review", "failed"), ...allSucceeded.filter((s) => s.stage !== "review")];
    expect(deriveChangeStatus({ merged: false, closed: false, headStageRuns: runs })).toBe("ready");
  });

  it("derives the same states the transitions reach", () => {
    expect(deriveChangeStatus({ merged: false, closed: false, headStageRuns: [] })).toBe("open");
    expect(
      deriveChangeStatus({ merged: false, closed: false, headStageRuns: [stage("ci", "queued")] }),
    ).toBe("processing");
    expect(deriveChangeStatus({ merged: true, closed: false, headStageRuns: [] })).toBe("merged");
    expect(deriveChangeStatus({ merged: false, closed: true, headStageRuns: allSucceeded })).toBe(
      "closed",
    );
  });
});

describe("section approval", () => {
  it("counts an approval only for the content it approved", () => {
    const s = section("a", "h1");
    expect(sectionApprovalState(s, [])).toBe("pending");
    expect(sectionApprovalState(s, [approval("1", "a", "h1")])).toBe("approved");
    expect(sectionApprovalState(s, [approval("1", "a", "h0")])).toBe("withdrawn");
  });

  it("withdraws only the approvals of sections a push changed", () => {
    const approvals = [
      approval("1", "a", "h1"),
      approval("2", "b", "h2"),
      approval("3", "c", "h3"),
      { ...approval("4", "a", "h0"), withdrawnAt: 5, withdrawnReason: "content_changed" as const },
    ];
    const after = [section("a", "h1"), section("b", "h2-changed")];
    expect(approvalsWithdrawnByPush(after, approvals)).toEqual([
      { approvalId: "apr_2", sectionId: "sec_b", reason: "content_changed" },
      { approvalId: "apr_3", sectionId: "sec_c", reason: "section_removed" },
    ]);
  });

  it("lets a person approve again once the content moved", () => {
    const approvals = [approval("1", "a", "h1", "usr_a")];
    expect(canApprove(section("a", "h1"), approvals, "usr_a")).toBe(false);
    expect(canApprove(section("a", "h1"), approvals, "usr_b")).toBe(true);
    expect(canApprove(section("a", "h2"), approvals, "usr_a")).toBe(true);
  });
});

describe("merge readiness", () => {
  const sections = [section("a", "h1"), section("b", "h2")];
  const approvals = [approval("1", "a", "h1"), approval("2", "b", "h2", "usr_b")];
  const ready = {
    change: { status: "ready" as const },
    headStageRuns: allSucceeded,
    sections,
    approvals,
    threads: [thread("1", { status: "resolved" }), thread("2", { status: "dismissed" })],
  };

  it("is ready when sections are approved, comments settled and CI green", () => {
    expect(mergeReadiness(ready)).toEqual({ ready: true, blockers: [] });
  });

  it("names every blocker", () => {
    const result = mergeReadiness({
      change: { status: "processing" },
      headStageRuns: [stage("ci", "failed")],
      sections,
      approvals: [approvals[0] as Approval],
      threads: [thread("1"), thread("2", { kind: "chat" })],
    });
    expect(result.ready).toBe(false);
    expect(result.blockers).toEqual([
      { kind: "status", status: "processing" },
      { kind: "sections_unapproved", sectionIds: ["sec_b"] },
      { kind: "comments_open", threadIds: ["thr_1"] },
      { kind: "ci_not_green", status: "failed" },
    ]);
  });

  it("treats skipped CI as green and missing CI as not", () => {
    const skipped = [...allSucceeded.slice(0, 3), stage("ci", "skipped")];
    expect(mergeReadiness({ ...ready, headStageRuns: skipped }).ready).toBe(true);
    expect(mergeReadiness({ ...ready, headStageRuns: allSucceeded.slice(0, 3) }).blockers).toEqual([
      { kind: "ci_not_green", status: "missing" },
    ]);
  });

  it("blocks when there is nothing to approve", () => {
    expect(mergeReadiness({ ...ready, sections: [], approvals: [] }).blockers).toEqual([
      { kind: "no_sections" },
    ]);
  });

  it("is blocked again by a re-run that makes CI fail", () => {
    const runs = [...allSucceeded, stage("ci", "failed", 2)];
    expect(mergeReadiness({ ...ready, headStageRuns: runs }).ready).toBe(false);
  });
});

describe("decision strength", () => {
  it("starts active at the initial strength", () => {
    expect(initialDecisionState()).toEqual({
      strength: decisionStrength.initial,
      status: "active",
    });
  });

  it("is reinforced when followed, cited or confirmed, and never passes 1", () => {
    let state = initialDecisionState();
    const before = state.strength;
    state = applyDecisionEvent(state, "followed");
    expect(state.strength).toBeGreaterThan(before);
    for (let i = 0; i < 200; i++) state = applyDecisionEvent(state, "confirmed");
    expect(state.strength).toBeLessThanOrEqual(1);
    expect(state.status).toBe("active");
  });

  it("is weakened only by an accepted contradiction, and goes dormant below the threshold", () => {
    let state = initialDecisionState();
    state = applyDecisionEvent(state, "contradiction_accepted");
    expect(state).toEqual({ strength: 0.3, status: "active" });
    state = applyDecisionEvent(state, "contradiction_accepted");
    expect(state.status).toBe("dormant");
  });

  it("leaves strength alone when the wording changes", () => {
    const state = { strength: 0.8, status: "active" as const };
    expect(applyDecisionEvent(state, "reshaped")).toEqual(state);
    expect(applyDecisionEvent(state, "reverted")).toEqual(state);
  });

  it("can be revived, and reinforcement alone can wake a dormant decision", () => {
    const dormant = { strength: 0.1, status: "dormant" as const };
    expect(applyDecisionEvent(dormant, "revived")).toEqual({ strength: 0.5, status: "active" });
    expect(applyDecisionEvent({ strength: 0.9, status: "active" }, "revived").strength).toBe(0.9);
    expect(applyDecisionEvent(dormant, "confirmed").status).toBe("active");
  });
});

describe("workspace", () => {
  it("refuses to boot a sandbox until the workspace has been prepared", () => {
    const image = "cloudflare/debian-trixie";
    expect(() => workspaceStart({ image, snapshot: null })).toThrow(/not been prepared/);
    const snapshot = { id: "snap_1", image };
    expect(workspaceStart({ image, snapshot })).toEqual({ image, snapshot });
  });
});

describe("threads and sessions", () => {
  it("settles and reopens a comment", () => {
    const open = thread("1");
    expect(transitionThread(open, { type: "resolve" })).toEqual({
      status: "resolved",
      dismissal: null,
    });
    const dismissed = transitionThread(open, { type: "dismiss", classification: "not_a_problem" });
    expect(dismissed).toEqual({ status: "dismissed", dismissal: "not_a_problem" });
    expect(
      transitionThread(
        { ...open, ...dismissed },
        { type: "reclassify", classification: "design_decision" },
      ),
    ).toEqual({ status: "dismissed", dismissal: "design_decision" });
    expect(transitionThread({ ...open, ...dismissed }, { type: "reopen" }).status).toBe("open");
  });

  it("refuses to settle a chat or re-settle a comment", () => {
    expect(() => transitionThread(thread("1", { kind: "chat" }), { type: "resolve" })).toThrow(
      InvalidTransitionError,
    );
    expect(() =>
      transitionThread(thread("1", { status: "resolved" }), { type: "resolve" }),
    ).toThrow(InvalidTransitionError);
    expect(() =>
      transitionThread(thread("1"), { type: "reclassify", classification: "not_a_problem" }),
    ).toThrow(InvalidTransitionError);
  });

  it("places a comment in the first section, in reading order, that shows its file", () => {
    const sections = [
      section("late", "h", 2, ["a.ts", "b.ts"]),
      section("early", "h", 1, ["b.ts"]),
    ];
    expect(sectionForAnchor(sections, { path: "b.ts" })).toBe("sec_early");
    expect(sectionForAnchor(sections, { path: "a.ts" })).toBe("sec_late");
    expect(sectionForAnchor(sections, { path: "c.ts" })).toBeNull();
  });

  it("ends a session once", () => {
    expect(transitionSession("active", "merged")).toBe("merged");
    expect(() => transitionSession("merged", "abandoned")).toThrow(InvalidTransitionError);
  });
});
