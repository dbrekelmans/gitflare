import type { DecisionsPort } from "@gitflare/core/ports";
import { learnFromThread } from "./learn";
import { linkDecision, recordDecision, settleChangeDecisions } from "./record";
import { retrieveDecisions } from "./retrieve";
import type { DecisionsDeps } from "./store";

// @gitflare/decisions — the decision record. Each decision is a markdown file
// in the repository's context repo and a row in the index; the row carries its
// strength and an embedding. Reviews are given the decisions closest in
// meaning to the change. Strength moves only through `applyDecisionEvent`.
//
// An event lands in the index first, as one guarded write of the event and the
// decision's new state, and is then carried to the file. Rebuilding goes the
// other way: `reindexDecisions` reads the files, and the files win.

export { parseDecisionFile, renderDecisionFile } from "./file";
export { learnFromThread } from "./learn";
export { decisionHistory, listDecisions, revertDecision } from "./read";
export {
  linkDecision,
  recordDecision,
  recordDecisionEvent,
  settleChangeDecisions,
} from "./record";
export { reindexDecisions } from "./reindex";
export { retrieveDecisions } from "./retrieve";
export type { DecisionsDeps } from "./store";

/** The `DecisionsPort` the review and the pipeline use, over the functions above. */
export function createDecisionRecord(deps: DecisionsDeps): DecisionsPort {
  return {
    retrieve: (input) => retrieveDecisions(deps, input),
    record: (input) => recordDecision(deps, input),
    link: (input) => linkDecision(deps, input),
    learnFromThread: (threadId) => learnFromThread(deps, threadId),
    settleChange: (changeId) => settleChangeDecisions(deps, changeId),
  };
}
