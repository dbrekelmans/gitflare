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
   * Files whose changed lines, before times after, exceed this are reported
   * without hunks, as too large to diff. The diff's time grows with it.
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
        options?.maxDiffCells,
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
        options?.maxDiffCells,
      );
    }),
  ]);

  return diffs.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

const FROM_A = 1;
const FROM_B = 2;
const BELOW_COMMON = 4;

/**
 * The newest commit both histories contain: what a change is diffed against
 * when the main repo has moved on since the session forked. Walks both
 * histories at once, newest commit first, marking each commit with the sides
 * that reach it (git's paint-down). A commit both sides reach is a common
 * ancestor; everything beneath it is marked as such, and the walk stops once
 * nothing left to visit could lead to another. So it reads the commits since
 * the fork point, not both full histories.
 *
 * A common ancestor that is itself an ancestor of another one is not a merge
 * base, however short the path one side reaches it by. Among more than one
 * equally-near candidate (a criss-cross merge), the newest by `committedAt`
 * is returned. Commit dates order the walk but cannot make it wrong: a
 * candidate found early through a skewed date is dropped when another
 * candidate turns out to reach it.
 */
export async function mergeBase(
  deps: { git: GitHost },
  repo: string,
  a: Sha,
  b: Sha,
): Promise<Sha | null> {
  if (a === b) return a;
  const commits = new Map<Sha, GitCommit | null>();
  const read = async (sha: Sha): Promise<GitCommit | null> => {
    if (!commits.has(sha)) commits.set(sha, await deps.git.readCommit(repo, sha));
    return commits.get(sha) ?? null;
  };
  const flags = new Map<Sha, number>();
  // Newest first. Among equal dates, commits below a common ancestor first, so
  // that marking catches up with a side still walking (git dates are in
  // seconds, and a run of commits often shares one); then the one queued first.
  const queue: { sha: Sha; at: number; below: boolean; order: number }[] = [];
  let queued = 0;
  const visit = async (sha: Sha, mark: number) => {
    const before = flags.get(sha) ?? 0;
    if ((before | mark) === before) return;
    flags.set(sha, before | mark);
    const commit = await read(sha);
    if (!commit) return;
    const entry = {
      sha,
      at: commit.committedAt,
      below: Boolean((before | mark) & BELOW_COMMON),
      order: queued++,
    };
    const after = (other: typeof entry) =>
      other.at !== entry.at
        ? other.at < entry.at
        : other.below !== entry.below
          ? entry.below
          : other.order > entry.order;
    let index = queue.findIndex(after);
    if (index < 0) index = queue.length;
    queue.splice(index, 0, entry);
  };
  const stillLeads = () => queue.some(({ sha }) => !((flags.get(sha) ?? 0) & BELOW_COMMON));

  await Promise.all([visit(a, FROM_A), visit(b, FROM_B)]);
  const candidates = new Set<Sha>();
  while (stillLeads()) {
    const next = queue.shift();
    if (!next) break;
    let mark = flags.get(next.sha) ?? 0;
    if (mark === (FROM_A | FROM_B)) {
      candidates.add(next.sha);
      mark |= BELOW_COMMON;
    }
    const parents = (await read(next.sha))?.parents ?? [];
    await Promise.all(parents.map((parent) => visit(parent, mark)));
  }

  // The walk can stop before the mark reaches every older candidate.
  const left = [...candidates].filter((sha) => !((flags.get(sha) ?? 0) & BELOW_COMMON));
  const nearest: Sha[] = [];
  for (const sha of left) {
    let reached = false;
    for (const other of left) {
      if (other !== sha && (await reaches(read, other, sha))) reached = true;
    }
    if (!reached) nearest.push(sha);
  }
  return nearest.reduce<Sha | null>((best, sha) => {
    const bestAt = best ? commits.get(best)?.committedAt : undefined;
    const at = commits.get(sha)?.committedAt;
    if (at === undefined) return best;
    return bestAt === undefined || at > bestAt ? sha : best;
  }, null);
}

/**
 * Whether `candidate` is an ancestor of `from`. Commits older than the
 * candidate are not descended into: an ancestor is not normally newer than
 * its descendant, and this keeps two unrelated candidates from walking the
 * whole history.
 */
async function reaches(
  read: (sha: Sha) => Promise<GitCommit | null>,
  from: Sha,
  candidate: Sha,
): Promise<boolean> {
  const target = await read(candidate);
  if (!target) return false;
  const stack: Sha[] = [from];
  const visited = new Set<Sha>();
  for (let next = stack.pop(); next; next = stack.pop()) {
    if (next === candidate) return true;
    if (visited.has(next)) continue;
    visited.add(next);
    const commit = await read(next);
    if (!commit || commit.committedAt < target.committedAt) continue;
    stack.push(...commit.parents);
  }
  return false;
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
