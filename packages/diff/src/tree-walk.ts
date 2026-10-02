import type { Sha } from "@gitflare/core";
import type { GitHost, TreeEntry } from "@gitflare/core/ports";

/** A path whose entry differs (or exists on only one side) between two trees. */
export interface LeafChange {
  path: string;
  before: TreeEntry | null;
  after: TreeEntry | null;
}

function isTree(entry: TreeEntry | null): entry is TreeEntry & { type: "tree" } {
  return entry?.type === "tree";
}

/**
 * Every leaf whose content, type or presence differs between two trees.
 * Descends only where a directory's id differs between the two sides, so an
 * untouched subtree is never read.
 */
export async function collectChangedLeaves(
  git: GitHost,
  repo: string,
  baseTree: Sha | null,
  headTree: Sha | null,
  prefix: string,
  out: LeafChange[],
): Promise<void> {
  if (baseTree === headTree) return;
  const [baseEntries, headEntries] = await Promise.all([
    baseTree ? git.readTree(repo, baseTree) : Promise.resolve(null),
    headTree ? git.readTree(repo, headTree) : Promise.resolve(null),
  ]);
  const byName = new Map<string, { before: TreeEntry | null; after: TreeEntry | null }>();
  for (const entry of baseEntries ?? []) byName.set(entry.name, { before: entry, after: null });
  for (const entry of headEntries ?? []) {
    const existing = byName.get(entry.name);
    if (existing) existing.after = entry;
    else byName.set(entry.name, { before: null, after: entry });
  }

  for (const [name, { before, after }] of byName) {
    const path = `${prefix}${name}`;
    if (before?.sha === after?.sha && before?.type === after?.type) continue;

    if (isTree(before) && isTree(after)) {
      await collectChangedLeaves(git, repo, before.sha, after.sha, `${path}/`, out);
    } else if (isTree(before) && !isTree(after)) {
      await collectChangedLeaves(git, repo, before.sha, null, `${path}/`, out);
      if (after) out.push({ path, before: null, after });
    } else if (!isTree(before) && isTree(after)) {
      await collectChangedLeaves(git, repo, null, after.sha, `${path}/`, out);
      if (before) out.push({ path, before, after: null });
    } else {
      out.push({ path, before, after });
    }
  }
}

export interface RenamedLeaf {
  oldPath: string;
  newPath: string;
  entry: TreeEntry;
}

/**
 * Pairs an added leaf with a deleted one that carries the same blob, as an
 * exact-content rename. Mutates neither input; returns the renames found and
 * the leaves that were not part of one.
 */
export function pairRenames(leaves: readonly LeafChange[]): {
  renames: RenamedLeaf[];
  rest: LeafChange[];
} {
  const added = leaves.filter((leaf) => leaf.before === null && leaf.after !== null);
  const deleted = leaves.filter((leaf) => leaf.before !== null && leaf.after === null);
  const deletedBySha = new Map<Sha, LeafChange[]>();
  for (const leaf of deleted) {
    const sha = (leaf.before as TreeEntry).sha;
    const bucket = deletedBySha.get(sha);
    if (bucket) bucket.push(leaf);
    else deletedBySha.set(sha, [leaf]);
  }

  const renames: RenamedLeaf[] = [];
  const consumed = new Set<LeafChange>();
  for (const addedLeaf of added) {
    const after = addedLeaf.after as TreeEntry;
    const bucket = deletedBySha.get(after.sha);
    const match = bucket?.find((leaf) => leaf.before?.type === after.type && !consumed.has(leaf));
    if (!match) continue;
    consumed.add(addedLeaf);
    consumed.add(match);
    renames.push({ oldPath: match.path, newPath: addedLeaf.path, entry: after });
  }

  const rest = leaves.filter((leaf) => !consumed.has(leaf));
  return { renames, rest };
}
