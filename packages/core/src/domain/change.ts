import { z } from "zod";
import type {
  ChangeId,
  IntentId,
  MicroUsd,
  RepositoryId,
  RevisionId,
  SessionId,
  Sha,
  StageRunId,
  Timestamp,
  UserId,
} from "../ids";

/**
 * `open`        pushed; the pipeline has not claimed the head revision yet
 * `processing`  at least one stage of the head revision is queued or running
 * `ready`       every stage has settled (succeeded, failed or skipped): ready for people
 * `merged`      gitflare merged it into the main repo
 * `closed`      abandoned without merging
 *
 * `ready` means ready to be reviewed. Whether it may merge is a separate
 * question, answered by `mergeReadiness`.
 */
export const ChangeStatus = z.enum(["open", "processing", "ready", "merged", "closed"]);
export type ChangeStatus = z.infer<typeof ChangeStatus>;

/** A change is what one session pushed: one fork, one branch, reviewed and merged as a whole. */
export interface Change {
  id: ChangeId;
  repositoryId: RepositoryId;
  sessionId: SessionId;
  /** Sequential per repository; what people say out loud. */
  number: number;
  title: string;
  status: ChangeStatus;
  authorId: UserId;
  /** The branch in the fork this change tracks: the first one pushed. */
  headRef: string;
  baseSha: Sha;
  headSha: Sha;
  headRevisionId: RevisionId;
  openedAt: Timestamp;
  /** When the head revision's stages last all settled. */
  readyAt: Timestamp | null;
  mergedAt: Timestamp | null;
  mergedBy: UserId | null;
  mergeSha: Sha | null;
  closedAt: Timestamp | null;
}

/** One push to the change's branch. Stages, sections and approvals refer to revisions. */
export interface Revision {
  id: RevisionId;
  changeId: ChangeId;
  number: number;
  baseSha: Sha;
  headSha: Sha;
  pushedAt: Timestamp;
  stats: DiffStats;
}

export interface DiffStats {
  commits: number;
  filesChanged: number;
  insertions: number;
  deletions: number;
}

export interface ChangeCommit {
  changeId: ChangeId;
  revisionId: RevisionId;
  sha: Sha;
  message: string;
  authorName: string;
  authorEmail: string;
  authoredAt: Timestamp;
  /** Every `Entire-Checkpoint` trailer on the commit; a commit can carry several. */
  checkpointIds: string[];
}

export const StageName = z.enum(["intent", "sections", "review", "ci"]);
export type StageName = z.infer<typeof StageName>;
export const stageNames = StageName.options;

export const StageStatus = z.enum(["queued", "running", "succeeded", "failed", "skipped"]);
export type StageStatus = z.infer<typeof StageStatus>;

/** One attempt at one stage for one revision. A re-run is a new attempt, not an edit. */
export interface StageRun {
  id: StageRunId;
  changeId: ChangeId;
  revisionId: RevisionId;
  stage: StageName;
  attempt: number;
  status: StageStatus;
  /** Why a stage was skipped or failed, in words a reviewer can read. */
  reason: string | null;
  startedAt: Timestamp | null;
  finishedAt: Timestamp | null;
}

/** How the intent was arrived at. Shown to reviewers; not equally trustworthy. */
export const IntentGrade = z.enum(["transcript", "diff", "stated"]);
export type IntentGrade = z.infer<typeof IntentGrade>;

/**
 * What the change is for. Derived once when the change opens and then left
 * alone; re-running the intent stage adds a version rather than rewriting one.
 */
export interface Intent {
  id: IntentId;
  changeId: ChangeId;
  revisionId: RevisionId;
  version: number;
  statement: string;
  grade: IntentGrade;
  /** Checkpoints the derivation read; empty for a diff-derived intent. */
  checkpointIds: string[];
  model: string | null;
  createdAt: Timestamp;
}

export interface ChangeCost {
  changeId: ChangeId;
  totalMicroUsd: MicroUsd;
  byAgent: Partial<Record<AgentName, MicroUsd>>;
  /** Gateway cost figures are estimates; say so wherever this is shown. */
  estimated: true;
}

/** The platform's own agents, and the hosted session agent. Also the gateway metadata value. */
export const AgentName = z.enum(["intent", "sections", "review", "thread", "decisions", "session"]);
export type AgentName = z.infer<typeof AgentName>;
