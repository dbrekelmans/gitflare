import type { DiffStats, FileDiff, FileStatus, GitCommit, Sha } from "@gitflare/core";
import type { DiffPort, GitHost, TreeEntry } from "@gitflare/core/ports";
import { lineDiffStatus } from "./line-diff";
import { collectChangedLeaves, type LeafChange, pairRenames } from "./tree-walk";

// @gitflare/diff — what changed between two commits, computed in the Worker
// from the git host's object reads. The host has no diff endpoint and a
// container is too slow for a page load, so this walks the two trees
// (descending only where tree ids differ) and line-diffs the blobs that
// changed. Build task: `diff`.

// Hunk and section hashes are defined once, in `@gitflare/core`
// (`hunkHash`, `sectionContentHash`, `selectDiff`). Every hunk this package
// produces carries `hunkHash(path, lines)`, via `lineDiffStatus`.

/** The `DiffPort` the rest of the forge uses, over the functions below. */
export function createDiffs(deps: { git: GitHost }): DiffPort {
  return {
    between: (repo, baseSha, headSha) => diffCommits(deps, repo, baseSha, headSha),
    mergeBase: (repo, a, b) => mergeBase(deps, repo, a, b),
    format: formatUnified,
  };
}

export interface DiffOptions {
  /** Files larger than this are reported without hunks. */
  maxFileBytes?: number;
  /** Lines of unchanged context around each hunk. */
  contextLines?: number;
}

const DEFAULT_MAX_FILE_BYTES = 1_000_000;

const decoder = new TextDecoder();

function isBinary(bytes: Uint8Array): boolean {
  const sampleLength = Math.min(bytes.length, 8000);
  for (let i = 0; i < sampleLength; i++) {
    if (bytes[i] === 0) return true;
  }
  return false;
}

async function fileDiffFor(
  git: GitHost,
  repo: string,
  path: string,
  oldPath: string | null,
  status: FileStatus,
  before: TreeEntry | null,
  after: TreeEntry | null,
  maxFileBytes: number,
  contextLines: number | undefined,
): Promise<FileDiff> {
  const readable = (entry: TreeEntry | null): entry is TreeEntry =>
    entry !== null && entry.type !== "gitlink";
  const [beforeBytes, afterBytes] = await Promise.all([
    readable(before) ? git.readBlob(repo, before.sha) : Promise.resolve(null),
    readable(after) ? git.readBlob(repo, after.sha) : Promise.resolve(null),
  ]);

  const isGitlink = before?.type === "gitlink" || after?.type === "gitlink";
  const bytes = [beforeBytes, afterBytes].filter((b): b is Uint8Array => b !== null);
  const binary = isGitlink || bytes.some((b) => b.length > maxFileBytes || isBinary(b));
  if (binary) {
    return { path, oldPath, status, binary: true, insertions: 0, deletions: 0, hunks: [] };
  }

  const beforeText = beforeBytes ? decoder.decode(beforeBytes) : null;
  const afterText = afterBytes ? decoder.decode(afterBytes) : null;
  if (beforeText === afterText) {
    return { path, oldPath, status, binary: false, insertions: 0, deletions: 0, hunks: [] };
  }
  return { ...lineDiffStatus(path, beforeText, afterText, status, contextLines), oldPath };
}

/** The files that differ between two commits of one repository, in path order. */
export async function diffCommits(
  deps: { git: GitHost },
  repo: string,
  baseSha: Sha,
  headSha: Sha,
  options?: DiffOptions,
): Promise<FileDiff[]> {
  const maxFileBytes = options?.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const contextLines = options?.contextLines;
  const [baseCommit, headCommit] = await Promise.all([
    deps.git.readCommit(repo, baseSha),
    deps.git.readCommit(repo, headSha),
  ]);
  const baseTree = baseCommit?.treeSha ?? null;
  const headTree = headCommit?.treeSha ?? null;

  const leaves: LeafChange[] = [];
  await collectChangedLeaves(deps.git, repo, baseTree, headTree, "", leaves);
  const { renames, rest } = pairRenames(leaves);

  const diffs = await Promise.all([
    ...renames.map((rename) =>
      fileDiffFor(
        deps.git,
        repo,
        rename.newPath,
        rename.oldPath,
        "renamed",
        rename.entry,
        rename.entry,
        maxFileBytes,
        contextLines,
      ),
    ),
    ...rest.map((leaf) => {
      const status: FileStatus =
        leaf.before === null ? "added" : leaf.after === null ? "deleted" : "modified";
      return fileDiffFor(
        deps.git,
        repo,
        leaf.path,
        null,
        status,
        leaf.before,
        leaf.after,
        maxFileBytes,
        contextLines,
      );
    }),
  ]);

  return diffs.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

async function ancestry(git: GitHost, repo: string, sha: Sha): Promise<Map<Sha, GitCommit>> {
  const seen = new Map<Sha, GitCommit>();
  const queue: Sha[] = [sha];
  for (let next = queue.shift(); next; next = queue.shift()) {
    if (seen.has(next)) continue;
    const commit = await git.readCommit(repo, next);
    if (!commit) continue;
    seen.set(next, commit);
    queue.push(...commit.parents);
  }
  return seen;
}

/**
 * The newest commit both histories contain: what a change is diffed against
 * when the main repo has moved on since the session forked.
 */
export async function mergeBase(
  deps: { git: GitHost },
  repo: string,
  a: Sha,
  b: Sha,
): Promise<Sha | null> {
  if (a === b) return a;
  const [ancestorsOfA, ancestorsOfB] = await Promise.all([
    ancestry(deps.git, repo, a),
    ancestry(deps.git, repo, b),
  ]);
  let best: GitCommit | null = null;
  for (const [sha, commit] of ancestorsOfA) {
    if (!ancestorsOfB.has(sha)) continue;
    if (!best || commit.committedAt > best.committedAt) best = commit;
  }
  return best?.sha ?? null;
}

export function diffStats(diff: FileDiff[], commits: number): DiffStats {
  return {
    commits,
    filesChanged: diff.length,
    insertions: diff.reduce((sum, file) => sum + file.insertions, 0),
    deletions: diff.reduce((sum, file) => sum + file.deletions, 0),
  };
}

/** A unified-diff rendering, for prompts. */
export function formatUnified(diff: FileDiff[]): string {
  return diff
    .map((file) => {
      const oldPath = file.oldPath ?? file.path;
      if (file.binary) {
        return `Binary files ${file.status === "added" ? "/dev/null" : `a/${oldPath}`} and ${
          file.status === "deleted" ? "/dev/null" : `b/${file.path}`
        } differ`;
      }
      return [
        `--- ${file.status === "added" ? "/dev/null" : `a/${oldPath}`}`,
        `+++ ${file.status === "deleted" ? "/dev/null" : `b/${file.path}`}`,
        ...file.hunks.flatMap((hunk) => [
          `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
          ...hunk.lines.map(
            (line) =>
              `${line.kind === "add" ? "+" : line.kind === "delete" ? "-" : " "}${line.text}`,
          ),
        ]),
      ].join("\n");
    })
    .join("\n");
}
