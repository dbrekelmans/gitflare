// @gitflare/sections — dividing one change into sections a person can read
// and approve in order: behaviour first, mechanical changes grouped apart,
// each with an explanation written from the transcript and the code.
// Build task: `sections`.

export { type FoldResult, foldRevision } from "./fold";
export { runSectionsStage, type SectionsDeps } from "./stage";
