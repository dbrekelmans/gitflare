import { sha1 } from "../hash";
import type { DiffLine, FileDiff, SectionFile } from "./section";

/**
 * A hunk's identity: its path and its added and deleted lines, in order.
 * Line numbers and context lines are left out, so a hunk that only moved
 * because of an edit elsewhere in the file keeps its hash.
 */
export function hunkHash(path: string, lines: readonly DiffLine[]): string {
  const changed = lines
    .filter((line) => line.kind !== "context")
    .map((line) => `${line.kind === "add" ? "+" : "-"}${line.text}`);
  return sha1(`${path}\n${changed.join("\n")}`);
}

/** The part of a diff a section presents, in the section's own file order. */
export function selectDiff(diff: readonly FileDiff[], files: readonly SectionFile[]): FileDiff[] {
  const selected: FileDiff[] = [];
  for (const selection of files) {
    const file = diff.find((candidate) => candidate.path === selection.path);
    if (!file) continue;
    if (selection.hunkHashes.length === 0) {
      selected.push(file);
      continue;
    }
    const hunks = file.hunks.filter((hunk) => selection.hunkHashes.includes(hunk.hash));
    if (hunks.length > 0) selected.push({ ...file, hunks });
  }
  return selected;
}

/**
 * A section's `contentHash`: what its approvals are tied to. It changes when,
 * and only when, a hunk the section presents is added, removed or altered, or
 * a file it presents changes status. This one function is the definition;
 * everything that hashes a section calls it.
 */
export function sectionContentHash(
  diff: readonly FileDiff[],
  files: readonly SectionFile[],
): string {
  const parts = selectDiff(diff, files).map(
    (file) => `${file.path}:${file.status}:${file.hunks.map((hunk) => hunk.hash).join(",")}`,
  );
  return sha1(parts.join("\n"));
}
