import type { PushKind } from "@gitflare/core";

// @gitflare/pipeline — the life of a change from push to merge, as plain
// functions. The change-pipeline Workflow in
// `apps/forge/src/server/workflows/change-pipeline.ts` calls them one Workflow
// step at a time; nothing here knows it is running in a Workflow, and every
// function is safe to run twice. Build task: `pipeline`.

export { approveSection, rerunStage, revokeApproval } from "./approvals";
export type { PipelineDeps } from "./deps";
export { changeReadiness, closeChange, describeBlocker, endSession, mergeChange } from "./merge";
export { handlePush, type PushResult } from "./push";
export {
  CHECKPOINT_POLL_MS,
  CHECKPOINT_WAIT_MS,
  missingCheckpoints,
  queueStageRerun,
  recordStageOutcome,
  runStage,
  settleChange,
  startStage,
} from "./stages";
export { changeDetail, ciView, listChanges, sectionDiff } from "./views";
export type { PushKind };
