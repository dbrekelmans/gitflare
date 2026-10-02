import type {
  Approval,
  ChangeStatus,
  IntentGrade,
  MergeBlocker,
  StageName,
  StageRun,
  StageStatus,
} from "@gitflare/core";
import type { CaptureSummary } from "@gitflare/core/api";
import type { StatusTone } from "@gitflare/ui/components/status";

// What the page says about each state. Kept apart from the components so the
// wording of a state is in one place and can be tested without rendering.

export function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

export const changeStatusCopy: Record<ChangeStatus, { label: string; tone: StatusTone }> = {
  open: { label: "Just pushed", tone: "neutral" },
  processing: { label: "Pipeline running", tone: "neutral" },
  ready: { label: "Ready for review", tone: "neutral" },
  merged: { label: "Merged", tone: "success" },
  closed: { label: "Closed", tone: "neutral" },
};

export const intentGradeCopy: Record<IntentGrade, { headline: string; detail: string }> = {
  transcript: {
    headline: "Derived from the session's transcript.",
    detail: "It is what the author asked the agent for, in their own words.",
  },
  diff: {
    headline: "Derived from the diff alone.",
    detail:
      "No transcript was read, so this is the pipeline's reading of the code, not what anyone asked for.",
  },
};

export function captureCopy(capture: CaptureSummary): { headline: string; detail: string } {
  const missing = plural(capture.missingCheckpointIds.length, "checkpoint");
  switch (capture.state) {
    case "present":
      return {
        headline: "The session was captured.",
        detail: "Every checkpoint the commits name has arrived.",
      };
    case "pending":
      return {
        headline: "Waiting for the capture.",
        detail: `${missing} named by the commits ${capture.missingCheckpointIds.length === 1 ? "has" : "have"} not arrived yet. The pipeline waits a minute, then goes on without.`,
      };
    case "missing":
      return {
        headline: "The capture is missing.",
        detail: `${missing} named by the commits never arrived. The change went on without; this can be permanent.`,
      };
    case "none":
      return {
        headline: "Nothing was captured.",
        detail: "The commits name no checkpoint, so there is no transcript behind this change.",
      };
  }
}

export const stageLabel: Record<StageName, string> = {
  intent: "Intent",
  sections: "Sections",
  review: "Review",
  ci: "CI",
};

const stageStatusLabel: Record<StageStatus, string> = {
  queued: "Queued",
  running: "Running",
  succeeded: "Done",
  failed: "Failed",
  skipped: "Skipped",
};

export function stageStatusCopy(run: Pick<StageRun, "stage" | "status">): string {
  if (run.stage === "ci" && run.status === "succeeded") return "Passed";
  return stageStatusLabel[run.status];
}

export const stageTone: Record<StageStatus, StatusTone> = {
  queued: "neutral",
  running: "neutral",
  succeeded: "success",
  failed: "danger",
  skipped: "neutral",
};

/** One blocker as a sentence. Unapproved sections are listed by the card itself, as links. */
export function blockerCopy(blocker: MergeBlocker): string {
  switch (blocker.kind) {
    case "status":
      return blocker.status === "open" || blocker.status === "processing"
        ? "The pipeline is still working on the latest push."
        : `The change is ${blocker.status}.`;
    case "no_sections":
      return "There are no sections to approve yet.";
    case "sections_unapproved":
      return `${plural(blocker.sectionIds.length, "section")} still ${blocker.sectionIds.length === 1 ? "needs" : "need"} an approval:`;
    case "comments_open":
      return `${plural(blocker.threadIds.length, "comment")} ${blocker.threadIds.length === 1 ? "is" : "are"} still open.`;
    case "ci_not_green":
      if (blocker.status === "failed") return "CI failed.";
      if (blocker.status === "missing") return "CI has not reported for this revision.";
      return "CI has not finished.";
  }
}

export function withdrawalCopy(approval: Pick<Approval, "withdrawnReason">): string {
  switch (approval.withdrawnReason) {
    case "revoked":
      return "taken back by the approver";
    case "section_removed":
      return "the section was removed";
    default:
      return "a later push changed this section";
  }
}

export function diffStat(insertions: number, deletions: number): string {
  return `+${insertions} −${deletions}`;
}
