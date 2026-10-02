import { type DiffLine, type FileDiff, type FileStatus, type Hunk, hunkHash } from "@gitflare/core";

type Op = { kind: DiffLine["kind"]; text: string };

/**
 * Longest-common-subsequence line diff over the two middle sections only
 * (the common prefix and suffix are stripped by the caller): deterministic,
 * so the same two texts always split into the same hunks.
 */
function lineOps(before: readonly string[], after: readonly string[]): Op[] {
  const rows = before.length;
  const cols = after.length;
  const lcs: number[][] = Array.from({ length: rows + 1 }, () =>
    new Array<number>(cols + 1).fill(0),
  );
  for (let i = rows - 1; i >= 0; i--) {
    for (let j = cols - 1; j >= 0; j--) {
      const row = lcs[i] as number[];
      row[j] =
        before[i] === after[j]
          ? (lcs[i + 1]?.[j + 1] ?? 0) + 1
          : Math.max(lcs[i + 1]?.[j] ?? 0, row[j + 1] ?? 0);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < rows || j < cols) {
    if (i < rows && j < cols && before[i] === after[j]) {
      ops.push({ kind: "context", text: before[i] as string });
      i++;
      j++;
    } else if (j < cols && (i === rows || (lcs[i]?.[j + 1] ?? 0) > (lcs[i + 1]?.[j] ?? 0))) {
      ops.push({ kind: "add", text: after[j] as string });
      j++;
    } else {
      ops.push({ kind: "delete", text: before[i] as string });
      i++;
    }
  }
  return ops;
}

const DEFAULT_CONTEXT = 3;

/**
 * The LCS table is `(rows+1) * (cols+1)` numbers: a file rewritten with no
 * common prefix or suffix left (after trimming) above this many cells is
 * reported as oversized instead, so a large file cannot exhaust the Worker's
 * memory. 1,000,000 cells is a few tens of megabytes even without a typed
 * array, comfortably inside a Worker's limit.
 */
const DEFAULT_MAX_DIFF_CELLS = 1_000_000;

/** The two sides of a changed file, as text, with a known status. */
export function lineDiffStatus(
  path: string,
  before: string | null,
  after: string | null,
  status: FileStatus,
  contextLines: number = DEFAULT_CONTEXT,
  maxDiffCells: number = DEFAULT_MAX_DIFF_CELLS,
): FileDiff {
  const CONTEXT = contextLines;
  const split = (text: string | null) => (text ? text.replace(/\n$/, "").split("\n") : []);
  const beforeLines = split(before);
  const afterLines = split(after);

  // Trim the common prefix and suffix first: the lines that remain are the
  // only ones an optimal diff could possibly touch, and typically far fewer
  // than the whole file (a one-line change in a large, mostly-unchanged file
  // trims down to a tiny middle section).
  const commonBound = Math.min(beforeLines.length, afterLines.length);
  let prefix = 0;
  while (prefix < commonBound && beforeLines[prefix] === afterLines[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < commonBound - prefix &&
    beforeLines[beforeLines.length - 1 - suffix] === afterLines[afterLines.length - 1 - suffix]
  ) {
    suffix++;
  }
  const beforeMid = beforeLines.slice(prefix, beforeLines.length - suffix);
  const afterMid = afterLines.slice(prefix, afterLines.length - suffix);

  if (beforeMid.length * afterMid.length > maxDiffCells) {
    return { path, oldPath: null, status, binary: true, insertions: 0, deletions: 0, hunks: [] };
  }

  const prefixOps: Op[] = beforeLines.slice(0, prefix).map((text) => ({ kind: "context", text }));
  const suffixOps: Op[] = beforeLines
    .slice(beforeLines.length - suffix)
    .map((text) => ({ kind: "context", text }));
  const ops = [...prefixOps, ...lineOps(beforeMid, afterMid), ...suffixOps];

  const hunks: Hunk[] = [];
  let oldLine = 1;
  let newLine = 1;
  const oldLineBefore: number[] = [];
  const newLineBefore: number[] = [];
  const numbered: DiffLine[] = ops.map((op) => {
    oldLineBefore.push(oldLine);
    newLineBefore.push(newLine);
    const line: DiffLine = {
      kind: op.kind,
      text: op.text,
      oldLine: op.kind === "add" ? null : oldLine,
      newLine: op.kind === "delete" ? null : newLine,
    };
    if (op.kind !== "add") oldLine++;
    if (op.kind !== "delete") newLine++;
    return line;
  });

  let current: { lines: DiffLine[]; startIndex: number; trailing: number } | null = null;

  const close = () => {
    if (!current) return;
    const lines = current.lines.slice(
      0,
      current.lines.length - Math.max(0, current.trailing - CONTEXT),
    );
    const first = lines[0];
    hunks.push({
      // A hunk that opens with an insertion or a deletion (no context line
      // on that side, e.g. with `contextLines: 0`) has no line carrying the
      // position: fall back to the running counter from just before the
      // hunk, matching unified diff's `@@ -N,0 … @@` / `@@ … +N,0 @@`.
      oldStart:
        lines.find((line) => line.oldLine !== null)?.oldLine ??
        (oldLineBefore[current.startIndex] ?? 1) - 1,
      oldLines: lines.filter((line) => line.kind !== "add").length,
      newStart:
        lines.find((line) => line.newLine !== null)?.newLine ??
        (newLineBefore[current.startIndex] ?? 1) - 1,
      newLines: lines.filter((line) => line.kind !== "delete").length,
      lines,
      hash: hunkHash(path, lines),
    });
    if (!first) hunks.pop();
    current = null;
  };

  numbered.forEach((line, index) => {
    if (line.kind === "context") {
      if (current) {
        current.lines.push(line);
        current.trailing++;
        if (current.trailing > CONTEXT * 2) close();
      }
      return;
    }
    if (!current) {
      const startIndex = Math.max(0, index - CONTEXT);
      current = { lines: numbered.slice(startIndex, index), startIndex, trailing: 0 };
    }
    current.lines.push(line);
    current.trailing = 0;
  });
  close();

  return {
    path,
    oldPath: null,
    status,
    binary: false,
    insertions: numbered.filter((line) => line.kind === "add").length,
    deletions: numbered.filter((line) => line.kind === "delete").length,
    hunks,
  };
}
