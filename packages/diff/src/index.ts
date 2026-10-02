import { type DiffStats, type FileDiff, notImplemented, type Sha } from "@gitflare/core";
import type { DiffPort, GitHost } from "@gitflare/core/ports";

// @gitflare/diff — what changed between two commits, computed in the Worker
// from the git host's object reads. The host has no diff endpoint and a
// container is too slow for a page load, so this walks the two trees
// (descending only where tree ids differ) and line-diffs the blobs that
// changed. Build task: `diff`.

// Hunk and section hashes are defined once, in `@gitflare/core`
// (`hunkHash`, `sectionContentHash`, `selectDiff`). Every hunk this package
// produces carries `hunkHash(path, lines)`.

/** The `DiffPort` the rest of the forge uses, over the functions below. */
export function createDiffs(_deps: { git: GitHost }): DiffPort {
  return notImplemented("@gitflare/diff createDiffs");
}

export interface DiffOptions {
  /** Files larger than this are reported without hunks. */
  maxFileBytes?: number;
  /** Lines of unchanged context around each hunk. */
  contextLines?: number;
}

/** The files that differ between two commits of one repository, in path order. */
export async function diffCommits(
  _deps: { git: GitHost },
  _repo: string,
  _baseSha: Sha,
  _headSha: Sha,
  _options?: DiffOptions,
): Promise<FileDiff[]> {
  return notImplemented("@gitflare/diff diffCommits");
}

/**
 * The newest commit both histories contain: what a change is diffed against
 * when the main repo has moved on since the session forked.
 */
export async function mergeBase(
  _deps: { git: GitHost },
  _repo: string,
  _a: Sha,
  _b: Sha,
): Promise<Sha | null> {
  return notImplemented("@gitflare/diff mergeBase");
}

export function diffStats(_diff: FileDiff[], _commits: number): DiffStats {
  return notImplemented("@gitflare/diff diffStats");
}

/** A unified-diff rendering, for prompts. */
export function formatUnified(_diff: FileDiff[]): string {
  return notImplemented("@gitflare/diff formatUnified");
}
