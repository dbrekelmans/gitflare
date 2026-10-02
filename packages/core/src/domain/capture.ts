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

/** Entire's two id shapes: a 26-character ULID, or twelve hex characters from the legacy backend. */
export const CHECKPOINT_ID_PATTERN = "(?:[0-9a-f]{12}|[0-9A-HJKMNP-TV-Z]{26})";

const checkpointTrailer = new RegExp(
  `Entire-Checkpoint:\\s*(${CHECKPOINT_ID_PATTERN})(?:\\s|$)`,
  "g",
);

/**
 * Every checkpoint id named by `Entire-Checkpoint` trailers in a commit
 * message, in order, once each. A commit can carry several: squashes and
 * redone commits inherit the trailers of what they replace.
 */
export function parseCheckpointTrailers(message: string): string[] {
  const ids: string[] = [];
  for (const match of message.matchAll(checkpointTrailer)) {
    const id = match[1];
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

/**
 * `none`     the change's commits name no checkpoint: nothing was captured
 * `present`  every checkpoint the commits name has arrived
 * `pending`  some are missing and the pipeline is still waiting for them
 * `missing`  some never arrived; the change went on without them
 *
 * A trailer does not guarantee its checkpoint: the capture client's push
 * fails soft, and it can fail to write a checkpoint at all. `missing` is a
 * normal, possibly permanent state, and the change page says so.
 */
export type CaptureState = "none" | "present" | "pending" | "missing";

export function captureState(input: {
  /** Checkpoint ids named by the change's commits. */
  named: readonly string[];
  /** Those of them recorded in the context repo. */
  arrived: readonly string[];
  /** True while the pipeline's bounded wait for checkpoints is still running. */
  waiting: boolean;
}): CaptureState {
  if (input.named.length === 0) return "none";
  if (input.named.every((id) => input.arrived.includes(id))) return "present";
  return input.waiting ? "pending" : "missing";
}
