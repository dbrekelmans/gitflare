// @gitflare/artifacts — everything that talks to Cloudflare Artifacts, and
// the forge's own rules about repositories on it: one main repo only gitflare
// writes, a sibling context repo, one fork per session, and a record of which
// user every token was issued to. Facts and signatures:
// spec/research/artifacts.md and spec/research/live/artifacts-git.md.
// Build task: `artifacts`.

export type {
  ArtifactsBindingLike,
  ArtifactsCommitLike,
  ArtifactsCreateRepoResultLike,
  ArtifactsRepoInfoLike,
  ArtifactsRepoLike,
  ArtifactsTreeEntryLike,
} from "./binding";
export type { ArtifactsDeps } from "./deps";
export { createArtifactsGitHost } from "./host";
export {
  completeRepositoryImport,
  failRepositoryImport,
  provisionRepository,
} from "./repositories";
export { createSandboxGitWriter, type SandboxGitWriterDeps } from "./sandbox-writer";
export { completeSessionFork, launchCloudSession, openSession } from "./sessions";
export { issueGitCredential, mintSystemToken } from "./tokens";
export {
  createWorkerGitWriter,
  MergeTooLargeError,
  type WorkerGitWriterDeps,
} from "./worker-writer";
