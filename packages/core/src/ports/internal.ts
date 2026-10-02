import type { ChangeCapture, CheckpointRef } from "../domain/capture";
import type { Decision, DecisionOrigin } from "../domain/decision";
import type { Push } from "../domain/push";
import type { FileDiff } from "../domain/section";
import type { ChangeId, RepositoryId, Sha, ThreadId, UserId } from "../ids";

// Ports between gitflare's own packages. Nothing here leaves the Worker; these
// exist so that a package which needs another's work depends on an interface
// with a fake, not on the other package. The intent stage can then be built
// and tested before capture or diff exist. Production wires each to the
// package that implements it (`createCapture`, `createDiffs`,
// `createDecisionRecord`).

/** What the capture client recorded about how a change was made. `@gitflare/capture`. */
export interface CapturePort {
  /** Records the new tip of a checkpoint ref in a repository's context repo. */
  recordCheckpoint(
    repositoryId: RepositoryId,
    checkpointId: string,
    push: Push,
  ): Promise<CheckpointRef>;
  /** Checkpoint ids the change's commits name that have not arrived yet. */
  missingCheckpoints(changeId: ChangeId): Promise<string[]>;
  /** The sessions behind a change, sliced to the turns its commits cover. Empty when nothing was captured. */
  read(changeId: ChangeId): Promise<ChangeCapture>;
  /** A capture as prompt material: prompts and prose kept, tool runs collapsed, the middle elided first. */
  condense(capture: ChangeCapture): string;
  /** The files gitflare commits to a repository so the capture client pushes checkpoints to its context repo. */
  settingsFiles(input: { contextRepoPath: string }): Record<string, string>;
}

/** What changed between two commits. `@gitflare/diff`. */
export interface DiffPort {
  /** The files that differ between two commits of one repository, in path order. */
  between(repo: string, baseSha: Sha, headSha: Sha): Promise<FileDiff[]>;
  /** The newest commit both histories contain, or null. */
  mergeBase(repo: string, a: Sha, b: Sha): Promise<Sha | null>;
  /** A unified-diff rendering, for prompts. */
  format(diff: FileDiff[]): string;
}

export interface NewDecision {
  repositoryId: RepositoryId;
  title: string;
  statement: string;
  rationale: string;
  /** Leave empty for a general rule, which is the normal case. */
  globs: string[];
  origin: DecisionOrigin;
  changeId: ChangeId | null;
  threadId: ThreadId | null;
  userId: UserId | null;
}

export interface RetrievedDecision {
  decision: Decision;
  /** Cosine similarity to the query, 0 to 1. */
  similarity: number;
}

/** The decision record, as the review and the pipeline use it. `@gitflare/decisions`. */
export interface DecisionsPort {
  /**
   * The active decisions of a repository closest in meaning to `query`,
   * nearest first. When `changeId` is given, what was retrieved is recorded
   * against the change.
   */
  retrieve(input: {
    repositoryId: RepositoryId;
    query: string;
    limit: number;
    changeId?: ChangeId;
  }): Promise<RetrievedDecision[]>;
  /** Writes the decision's file, indexes it, and records `created`. */
  record(input: NewDecision): Promise<Decision>;
  /** Records how a change related to a decision it was reviewed against. */
  link(input: {
    changeId: ChangeId;
    decisionId: Decision["id"];
    relation: "followed" | "cited" | "contradicted";
    threadId?: ThreadId;
  }): Promise<void>;
  /** Looks through a settled thread for a decision worth keeping; records or reinforces it. */
  learnFromThread(threadId: ThreadId): Promise<Decision | null>;
  /** Called when a change merges: reinforces what it followed or cited, weakens what it contradicted. */
  settleChange(changeId: ChangeId): Promise<void>;
}
