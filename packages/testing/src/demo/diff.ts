import { type DiffLine, type FileDiff, type Hunk, hunkHash } from "@gitflare/core";

type Op = { kind: DiffLine["kind"]; text: string };

function lineOps(before: string[], after: string[]): Op[] {
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

const CONTEXT = 3;

/**
 * A line diff of two versions of a file, good enough to build fixture data
 * that agrees with the fixture's file contents. The real diff, with rename
 * and binary handling, is `@gitflare/diff`.
 */
export function lineDiff(path: string, before: string | null, after: string | null): FileDiff {
  const split = (text: string | null) => (text ? text.replace(/\n$/, "").split("\n") : []);
  const ops = lineOps(split(before), split(after));

  const hunks: Hunk[] = [];
  let oldLine = 1;
  let newLine = 1;
  let current: { lines: DiffLine[]; trailing: number } | null = null;
  const numbered: DiffLine[] = ops.map((op) => {
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

  const close = () => {
    if (!current) return;
    const lines = current.lines.slice(
      0,
      current.lines.length - Math.max(0, current.trailing - CONTEXT),
    );
    const first = lines[0];
    hunks.push({
      oldStart: lines.find((line) => line.oldLine !== null)?.oldLine ?? 0,
      oldLines: lines.filter((line) => line.kind !== "add").length,
      newStart: lines.find((line) => line.newLine !== null)?.newLine ?? 0,
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
      current = { lines: numbered.slice(Math.max(0, index - CONTEXT), index), trailing: 0 };
    }
    current.lines.push(line);
    current.trailing = 0;
  });
  close();

  return {
    path,
    oldPath: null,
    status: before === null ? "added" : after === null ? "deleted" : "modified",
    binary: false,
    insertions: numbered.filter((line) => line.kind === "add").length,
    deletions: numbered.filter((line) => line.kind === "delete").length,
    hunks,
  };
}

/** Diffs of every path that differs between two file sets, in path order. */
export function diffFiles(
  before: Record<string, string>,
  after: Record<string, string>,
): FileDiff[] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .sort()
    .filter((path) => before[path] !== after[path])
    .map((path) => lineDiff(path, before[path] ?? null, after[path] ?? null));
}
