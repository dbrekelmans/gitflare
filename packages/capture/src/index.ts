import {
  type ChangeCapture,
  type ChangeId,
  type CheckpointRef,
  notImplemented,
  type Push,
  type RepositoryId,
  type Sha,
} from "@gitflare/core";
import type { Clock, GitHost } from "@gitflare/core/ports";
import type { Db } from "@gitflare/db";

// @gitflare/capture — reading what Entire's CLI recorded. A commit carries
// `Entire-Checkpoint` trailers; each names a ref in the repository's context
// repo holding the whole session so far. This package finds those refs,
// slices out the part of each transcript that belongs to the change, and
// condenses it for a prompt. Format: spec/research/entire-capture.md.
// Build task: `capture`. Prototype to port: prototypes/derivation/src/transcript.ts.

export interface CaptureDeps {
  db: Db;
  git: GitHost;
  clock: Clock;
}

/** Every checkpoint id named by `Entire-Checkpoint` trailers in a commit message, in order, once each. */
export function parseCheckpointTrailers(_message: string): string[] {
  return notImplemented("@gitflare/capture parseCheckpointTrailers");
}

/** Records the new tip of a checkpoint ref. Called for every push the pipeline classifies as `checkpoint`. */
export async function recordCheckpointPush(
  _deps: Pick<CaptureDeps, "db" | "clock">,
  _repositoryId: RepositoryId,
  _checkpointId: string,
  _push: Push,
): Promise<CheckpointRef> {
  return notImplemented("@gitflare/capture recordCheckpointPush");
}

/** The checkpoints a change's commits name that have not arrived in the context repo yet. */
export async function missingCheckpoints(
  _deps: Pick<CaptureDeps, "db">,
  _changeId: ChangeId,
): Promise<string[]> {
  return notImplemented("@gitflare/capture missingCheckpoints");
}

/**
 * Reads the checkpoints behind a change at their current tips, slices each
 * cumulative transcript to the turns this change's commits cover, and stores
 * a `captured_sessions` row per agent session. A change with no checkpoints
 * yields an empty capture, never an error.
 */
export async function captureChange(
  _deps: CaptureDeps,
  _changeId: ChangeId,
): Promise<ChangeCapture> {
  return notImplemented("@gitflare/capture captureChange");
}

export interface CondenseOptions {
  maxChars: number;
  maxPromptChars: number;
  maxAssistantChars: number;
}

export const defaultCondenseOptions: CondenseOptions = {
  maxChars: 60_000,
  maxPromptChars: 4_000,
  maxAssistantChars: 1_500,
};

/**
 * A capture as prompt material: prompts and assistant prose kept, runs of tool
 * calls collapsed to name and target, and the middle elided first when it is
 * too long.
 */
export function condense(_capture: ChangeCapture, _options?: CondenseOptions): string {
  return notImplemented("@gitflare/capture condense");
}

/**
 * The files gitflare commits to a repository so the unmodified Entire CLI
 * pushes checkpoints to its context repo: `.entire/settings.json`,
 * `.entire/.gitignore` and the agent hook settings.
 */
export function captureSettingsFiles(_input: {
  /** The context repo's path on the git host, e.g. `git/<namespace>/<slug>.context`. */
  contextRepoPath: string;
}): Record<string, string> {
  return notImplemented("@gitflare/capture captureSettingsFiles");
}

/** A checkpoint ref's tree, read at one commit. Exposed for tests and for the review agent's citations. */
export async function readCheckpoint(
  _deps: Pick<CaptureDeps, "git">,
  _contextRepo: string,
  _tipSha: Sha,
): Promise<ChangeCapture["sessions"]> {
  return notImplemented("@gitflare/capture readCheckpoint");
}
