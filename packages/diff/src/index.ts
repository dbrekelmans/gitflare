import {
  type DiffStats,
  type FileDiff,
  type FileStatus,
  ForgeError,
  type GitCommit,
  type Sha,
} from "@gitflare/core";
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
  /**
   * A file whose two sides, after trimming their common prefix and suffix,
   * still multiply out to more line-diff table cells than this is reported
   * without hunks instead of being diffed, so a large rewrite cannot exhaust
   * the Worker's memory.
   */
  maxDiffCells?: number;
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
  maxDiffCells: number | undefined,
): Promise<FileDiff> {
  const readable = (entry: TreeEntry | null): entry is TreeEntry =>
    entry !== null && entry.type !== "gitlink";
  const readBlobOrThrow = async (sha: Sha): Promise<Uint8Array> => {
    const blob = await git.readBlob(repo, sha);
    if (!blob) throw new ForgeError("not_found", `blob ${sha} does not exist in ${repo}`);
    return blob;
  };

  // A rename pairs the same entry on both sides: read its blob once, not twice.
  const sameBlob = before !== null && after !== null && before.sha === after.sha;
  const [beforeBytes, afterBytes] = sameBlob
    ? await (async () => {
        const bytes = readable(before) ? await readBlobOrThrow(before.sha) : null;
        return [bytes, bytes] as const;
      })()
    : await Promise.all([
        readable(before) ? readBlobOrThrow(before.sha) : Promise.resolve(null),
        readable(after) ? readBlobOrThrow(after.sha) : Promise.resolve(null),
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
  return {
    ...lineDiffStatus(path, beforeText, afterText, status, contextLines, maxDiffCells),
    oldPath,
  };
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
  const maxDiffCells = options?.maxDiffCells;

  const repoInfo = await deps.git.getRepo(repo);
  if (!repoInfo) throw new ForgeError("not_found", `repo ${repo} does not exist`);
  if (repoInfo.status !== "ready") {
    throw new ForgeError("not_ready", `repo ${repo} is still ${repoInfo.status}`);
  }

  const [baseCommit, headCommit] = await Promise.all([
    deps.git.readCommit(repo, baseSha),
    deps.git.readCommit(repo, headSha),
  ]);
  if (!baseCommit) throw new ForgeError("not_found", `commit ${baseSha} does not exist in ${repo}`);
  if (!headCommit) throw new ForgeError("not_found", `commit ${headSha} does not exist in ${repo}`);
  const baseTree = baseCommit.treeSha;
  const headTree = headCommit.treeSha;

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
        maxDiffCells,
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
        maxDiffCells,
      );
    }),
  ]);

  return diffs.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * Expands one side's frontier by one generation (every parent of every
 * commit in it), recording each commit it has not seen before.
 */
async function expand(
  git: GitHost,
  repo: string,
  frontier: readonly Sha[],
  seen: Map<Sha, GitCommit>,
): Promise<Sha[]> {
  const commits = await Promise.all(frontier.map((sha) => git.readCommit(repo, sha)));
  const next: Sha[] = [];
  for (let i = 0; i < frontier.length; i++) {
    const sha = frontier[i] as Sha;
    const commit = commits[i];
    if (!commit || seen.has(sha)) continue;
    seen.set(sha, commit);
    next.push(...commit.parents);
  }
  return next;
}

/**
 * The newest commit both histories contain: what a change is diffed against
 * when the main repo has moved on since the session forked. Walks both
 * histories outward one generation at a time (not just first-parent, so a
 * true merge commit's other side is not missed) and returns as soon as a
 * commit both sides have reached appears, which is nearer by graph distance
 * than picking by timestamp, so clock skew cannot pick the wrong one.
 */
export async function mergeBase(
  deps: { git: GitHost },
  repo: string,
  a: Sha,
  b: Sha,
): Promise<Sha | null> {
  if (a === b) return a;
  const seenA = new Map<Sha, GitCommit>();
  const seenB = new Map<Sha, GitCommit>();
  const firstCommon = (): Sha | null => {
    for (const sha of seenA.keys()) if (seenB.has(sha)) return sha;
    return null;
  };
  let frontierA: Sha[] = [a];
  let frontierB: Sha[] = [b];
  while (frontierA.length > 0 || frontierB.length > 0) {
    if (frontierA.length > 0) frontierA = await expand(deps.git, repo, frontierA, seenA);
    const afterA = firstCommon();
    if (afterA) return afterA;
    if (frontierB.length > 0) frontierB = await expand(deps.git, repo, frontierB, seenB);
    const afterB = firstCommon();
    if (afterB) return afterB;
  }
  return null;
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
