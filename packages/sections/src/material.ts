import type { ChangeId, FileDiff, RevisionId } from "@gitflare/core";
import type { CapturePort, DiffPort } from "@gitflare/core/ports";
import { type Db, schema } from "@gitflare/db";
import { asc, desc, eq } from "drizzle-orm";
import type { ChangeMaterial, FileMaterial } from "./prompts/shared";

const { changeCommits, intents } = schema;

/** One file's diff is cut here, so that a generated file does not crowd out the rest. */
const FILE_CHARS = 12_000;
/** What one prompt spends on diffs altogether. Files past it are placed by path and size. */
const TOTAL_CHARS = 200_000;
const MAX_COMMITS = 50;
const COMMIT_CHARS = 2_000;

function cutShort(text: string): string {
  if (text.length <= FILE_CHARS) return text;
  const lineEnd = text.lastIndexOf("\n", FILE_CHARS);
  const kept = text.slice(0, lineEnd > 0 ? lineEnd : FILE_CHARS);
  const dropped = text.slice(kept.length).split("\n").length - 1;
  return `${kept}\n[diff cut short here: ${dropped} more lines]`;
}

/** The files of a diff as a prompt shows them, within what a prompt can spend on diffs. */
export function fileMaterial(
  diffs: Pick<DiffPort, "format">,
  files: readonly FileDiff[],
): FileMaterial[] {
  let left = TOTAL_CHARS;
  return files.map((file) => {
    const { path, oldPath, status, insertions, deletions } = file;
    let body: string;
    if (file.hunks.length === 0) {
      body = file.binary
        ? "[no diff: the file is binary or too large to diff]"
        : "[no diff: the file's lines did not change]";
    } else {
      body = cutShort(diffs.format([file]));
      if (body.length > left) {
        body = "[diff not shown: the change is too large to show every file]";
      }
      left -= body.length;
    }
    return { path, oldPath, status, insertions, deletions, body };
  });
}

/** What is known about a change apart from its diff: its commits, its intent and its session. */
export async function changeMaterial(
  deps: { db: Db; capture: CapturePort },
  change: { id: ChangeId; number: number; title: string },
  repositorySlug: string,
  revisionId: RevisionId,
): Promise<ChangeMaterial> {
  const [commits, [intent], capture] = await Promise.all([
    deps.db
      .select({ message: changeCommits.message, revisionId: changeCommits.revisionId })
      .from(changeCommits)
      .where(eq(changeCommits.changeId, change.id))
      .orderBy(asc(changeCommits.position)),
    deps.db
      .select({ statement: intents.statement })
      .from(intents)
      .where(eq(intents.changeId, change.id))
      .orderBy(desc(intents.version))
      .limit(1),
    deps.capture.read(change.id),
  ]);
  // On a first push every commit is the latest push's, and marking them says nothing.
  const laterPush = commits.some((commit) => commit.revisionId !== revisionId);
  const transcript = capture.sessions.length > 0 ? deps.capture.condense(capture).trim() : "";
  return {
    repositorySlug,
    number: change.number,
    title: change.title,
    intent: intent?.statement ?? null,
    commits: commits.slice(-MAX_COMMITS).map((commit) => ({
      message: commit.message.slice(0, COMMIT_CHARS),
      latestPush: laterPush && commit.revisionId === revisionId,
    })),
    transcript: transcript || null,
    missingCheckpoints: capture.missingCheckpointIds.length,
  };
}
