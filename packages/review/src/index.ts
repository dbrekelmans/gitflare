// @gitflare/review — the automatic review and the conversation that follows
// it. The review reads the change with the repository's relevant decisions and
// leaves findings as comment threads. When the author answers one, the agent
// replies, resolves it, dismisses it (saying which kind of dismissal it was),
// or pushes a fix to the session's fork. Build task: `review`.
//
// The three prompts are in `./prompts`, one file each.

export { appendMessage } from "./messages";
export { settleThread } from "./settle";
export { runReviewStage } from "./stage";
export type { DismissalTally, ReviewDeps, SettleAction } from "./store";
export { dismissalTally, heldBackCategories } from "./tally";
export { listThreads, openThread, threadView } from "./threads";
export { runAgentTurn } from "./turn";
