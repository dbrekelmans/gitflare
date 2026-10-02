import type { Decision, FileDiff } from "@gitflare/core";

// Renderings both prompts use for the same material, so the reviewing agent
// and the agent answering on a thread read a change the same way.

/**
 * A diff with both line numbers on every line. A finding is anchored by line
 * number, and a model asked to count lines from a hunk header gets them wrong;
 * here it copies them.
 */
export function numberedDiff(diff: readonly FileDiff[], maxChars: number): string {
  const parts: string[] = [];
  let used = 0;
  let omitted = 0;
  for (const file of diff) {
    const rendered = renderFile(file);
    if (used + rendered.length > maxChars) {
      omitted++;
      continue;
    }
    used += rendered.length;
    parts.push(rendered);
  }
  if (omitted > 0) {
    parts.push(
      `(${omitted} more changed ${omitted === 1 ? "file is" : "files are"} not shown: the diff is too large to include whole.)`,
    );
  }
  return parts.join("\n");
}

function renderFile(file: FileDiff): string {
  const from = file.oldPath ? ` renamed_from="${file.oldPath}"` : "";
  const open = `<file path="${file.path}" status="${file.status}"${from}>`;
  if (file.binary) return `${open}\n(binary or too large: no lines to show)\n</file>`;
  const column = (line: number | null) => String(line ?? "").padStart(5);
  const hunks = file.hunks.map((hunk) =>
    [
      `@@ base ${hunk.oldStart},${hunk.oldLines} head ${hunk.newStart},${hunk.newLines} @@`,
      ...hunk.lines.map(
        (line) =>
          `${column(line.oldLine)} ${column(line.newLine)} ${line.kind === "add" ? "+" : line.kind === "delete" ? "-" : " "} ${line.text}`,
      ),
    ].join("\n"),
  );
  return [open, " base  head", ...hunks, "</file>"].join("\n");
}

export function decisionList(decisions: readonly Decision[]): string {
  if (decisions.length === 0) return "(none: the record has nothing close to this)";
  return decisions
    .map((decision) =>
      [
        `<decision id="${decision.id}">`,
        `title: ${decision.title}`,
        `statement: ${decision.statement}`,
        `rationale: ${decision.rationale || "(none recorded)"}`,
        ...(decision.scope.kind === "paths"
          ? [`applies to: ${decision.scope.globs.join(", ")}`]
          : []),
        "</decision>",
      ].join("\n"),
    )
    .join("\n");
}
