import { ForgeError, type GitCommit, type Sha } from "@gitflare/core";
import type { GitHost } from "@gitflare/core/ports";

const OURS = 1;
const THEIRS = 2;
const BOTH = OURS | THEIRS;
/** Reachable from a common ancestor already found, so not a better one. */
const STALE = 4;

/** Enough for any change a person reviews; a walk that long means the histories are not related. */
const MAX_COMMITS_READ = 5_000;

export interface Relation {
  /**
   * `fast_forward`  ours is an ancestor of theirs
   * `up_to_date`    theirs is an ancestor of ours (or is ours)
   * `diverged`      both have commits the other lacks
   * `unrelated`     no common ancestor
   */
  kind: "fast_forward" | "up_to_date" | "diverged" | "unrelated";
  /** A common ancestor to merge from; null when unrelated. */
  base: Sha | null;
  /** How deep a shallow fetch of each side must be to include `base`. */
  oursDepth: number;
  theirsDepth: number;
}

/**
 * How two commits relate, found the way `git merge-base` finds it: both
 * histories are walked newest first, each commit marked with the side it was
 * reached from, until every commit left to visit is behind a common ancestor.
 * The walk follows every parent, not only the first, and reads one commit per
 * step, so its cost is the commits since the histories parted, not the size
 * of the repository.
 *
 * The two commits can be in different repositories: a fork holds what its
 * parent held when it was made, and each has commits the other lacks.
 */
export async function relate(
  git: GitHost,
  ours: { repo: string; sha: Sha },
  theirs: { repo: string; sha: Sha },
): Promise<Relation> {
  const flags = new Map<Sha, number>();
  const commits = new Map<Sha, GitCommit>();
  const queue: Sha[] = [];

  async function load(sha: Sha, side: number): Promise<GitCommit> {
    const known = commits.get(sha);
    if (known) return known;
    if (commits.size >= MAX_COMMITS_READ) {
      throw new ForgeError("unavailable", "the histories are too far apart to merge");
    }
    const [first, second] = side & OURS ? [ours.repo, theirs.repo] : [theirs.repo, ours.repo];
    const commit = (await git.readCommit(first, sha)) ?? (await git.readCommit(second, sha));
    if (!commit) throw new ForgeError("not_found", `commit ${sha} does not exist`);
    commits.set(sha, commit);
    return commit;
  }

  async function mark(sha: Sha, add: number): Promise<void> {
    const current = flags.get(sha) ?? 0;
    if ((current & add) === add) return;
    flags.set(sha, current | add);
    await load(sha, current | add);
    if (!queue.includes(sha)) queue.push(sha);
  }

  await mark(ours.sha, OURS);
  await mark(theirs.sha, THEIRS);

  const bases: Sha[] = [];
  while (queue.some((sha) => !((flags.get(sha) ?? 0) & STALE))) {
    queue.sort((a, b) => (commits.get(b)?.committedAt ?? 0) - (commits.get(a)?.committedAt ?? 0));
    const sha = queue.shift();
    if (!sha) break;
    let inherited = flags.get(sha) ?? 0;
    if ((inherited & BOTH) === BOTH && !(inherited & STALE)) {
      bases.push(sha);
      inherited |= STALE;
      flags.set(sha, inherited);
    }
    for (const parent of commits.get(sha)?.parents ?? []) await mark(parent, inherited);
  }

  const reached = (side: number) =>
    [...flags.values()].filter((value) => value & side && !(value & STALE)).length + 1;
  const kind = bases.includes(ours.sha)
    ? "fast_forward"
    : bases.includes(theirs.sha)
      ? "up_to_date"
      : bases.length > 0
        ? "diverged"
        : "unrelated";
  return {
    kind: ours.sha === theirs.sha ? "up_to_date" : kind,
    base: bases[0] ?? null,
    oursDepth: reached(OURS),
    theirsDepth: reached(THEIRS),
  };
}
