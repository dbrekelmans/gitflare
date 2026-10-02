import type { ChangeId, RepositoryId, Sha, Timestamp } from "../ids";

/**
 * A checkpoint ref in a repository's context repo, as last seen. Checkpoints
 * are not immutable: a later push to the same ref is an update, so readers
 * always start from `tipSha`.
 */
export interface CheckpointRef {
  /** The id in the `Entire-Checkpoint` trailer: a 26-character ULID or 12 hex characters. */
  checkpointId: string;
  repositoryId: RepositoryId;
  ref: string;
  tipSha: Sha;
  firstSeenAt: Timestamp;
  updatedAt: Timestamp;
}

export interface TranscriptTurn {
  kind: "prompt" | "assistant" | "tool";
  text: string;
  at: Timestamp | null;
}

export interface Attribution {
  agentLines: number;
  humanLines: number;
  /** 0 to 100. */
  agentPercentage: number;
}

/**
 * One agent session's part in a change: the turns that belong to this change's
 * commits, already sliced out of the cumulative transcript.
 */
export interface CapturedSession {
  changeId: ChangeId;
  /** The agent's own session id. */
  agentSessionId: string;
  agent: string;
  model: string | null;
  checkpointIds: string[];
  turns: TranscriptTurn[];
  attribution: Attribution | null;
}

/** Everything the intent, sectioning and review stages read about how a change was made. */
export interface ChangeCapture {
  changeId: ChangeId;
  sessions: CapturedSession[];
  /** Checkpoint ids named by commit trailers that never arrived in the context repo. */
  missingCheckpointIds: string[];
}
