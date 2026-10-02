import { type FileDiff, type Section, sectionContentHash, selectDiff } from "@gitflare/core";

export interface FoldResult {
  /** Every section after the fold, in reading order. Untouched sections are returned unchanged. */
  sections: Section[];
  /** Hunks that fit no existing section; the caller asks the model where they belong. */
  unplaced: FileDiff[];
}

/** What of one file no section presents: the file itself, some of its hunks, or null. */
function unclaimed(file: FileDiff, existing: readonly Section[]): FileDiff | null {
  const claims = existing.flatMap((section) =>
    section.files.filter((claim) => claim.path === file.path),
  );
  if (claims.some((claim) => claim.hunkHashes.length === 0)) return null;
  const named = new Set(claims.flatMap((claim) => claim.hunkHashes));
  const loose = file.hunks.filter((hunk) => !named.has(hunk.hash));
  // A file without hunks (a binary one) can only be presented whole.
  if (loose.length === file.hunks.length) return file;
  return loose.length > 0 ? { ...file, hunks: loose } : null;
}

/**
 * Folds a new revision's diff into existing sections without consulting a
 * model: a section keeps its files, its `contentHash` is recomputed with
 * `sectionContentHash`, and a
 * section left with nothing to show is dropped. Pure, so the rule that decides
 * which approvals survive a push is testable on its own.
 */
export function foldRevision(existing: Section[], diff: FileDiff[]): FoldResult {
  const sections: Section[] = [];
  for (const section of [...existing].sort((a, b) => a.position - b.position)) {
    if (selectDiff(diff, section.files).length === 0) continue;
    const contentHash = sectionContentHash(diff, section.files);
    sections.push(contentHash === section.contentHash ? section : { ...section, contentHash });
  }
  const unplaced = diff.flatMap((file) => unclaimed(file, existing) ?? []);
  return { sections, unplaced };
}
