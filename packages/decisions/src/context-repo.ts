import { contextRepoName, type DecisionId, ForgeError, type Sha } from "@gitflare/core";
import type { FileChange } from "@gitflare/core/ports";
import { schema, toDecision } from "@gitflare/db";
import { inArray } from "drizzle-orm";
import { DECISIONS_DIR, renderDecisionFile } from "./file";
import {
  type DecisionRow,
  type DecisionsDeps,
  decisionsAuthor,
  inPieces,
  type RepositoryRow,
} from "./store";

const BRANCH = "main";
const ATTEMPTS = 4;
const decoder = new TextDecoder();

/**
 * Makes the files of these decisions say what the index says, in one commit.
 * The index is where an event lands first; this carries it to the context
 * repo. It reads the branch's tip before it reads the rows and commits only
 * on top of that tip, so when two writers race the later commit is always
 * rendered from rows at least as new as the earlier one's. Running it again
 * when nothing differs commits nothing.
 */
export async function syncDecisionFiles(
  deps: Pick<DecisionsDeps, "db" | "git" | "gitWriter">,
  repository: Pick<RepositoryRow, "slug">,
  decisionIds: DecisionId[],
  message: string,
): Promise<Sha | null> {
  if (decisionIds.length === 0) return null;
  const repo = contextRepoName(repository.slug);
  for (let attempt = 1; ; attempt++) {
    const tip = await deps.git.resolveRef(repo, BRANCH);
    const rows: DecisionRow[] = [];
    for (const ids of inPieces(decisionIds)) {
      rows.push(
        ...(await deps.db.select().from(schema.decisions).where(inArray(schema.decisions.id, ids))),
      );
    }

    const changes: FileChange[] = [];
    const written: DecisionId[] = [];
    for (const row of rows) {
      const content = renderDecisionFile(toDecision(row));
      const current = tip ? await deps.git.readFile(repo, { ref: tip, path: row.path }) : null;
      if (current && decoder.decode(current) === content) continue;
      changes.push({ path: row.path, content });
      written.push(row.id);
    }
    if (changes.length === 0) return null;

    try {
      const { sha } = await deps.gitWriter.commitFiles({
        repo,
        branch: BRANCH,
        expectedParent: tip,
        changes,
        message,
        author: decisionsAuthor,
      });
      for (const ids of inPieces(written)) {
        await deps.db
          .update(schema.decisions)
          .set({ fileSha: sha })
          .where(inArray(schema.decisions.id, ids));
      }
      return sha;
    } catch (error) {
      const moved = error instanceof ForgeError && error.code === "conflict";
      if (!moved || attempt === ATTEMPTS) throw error;
    }
  }
}

export interface DecisionFile {
  path: string;
  text: string;
}

/** Every markdown file directly under `decisions/` at the context repo's tip, in path order. */
export async function readDecisionFiles(
  deps: Pick<DecisionsDeps, "git">,
  repository: Pick<RepositoryRow, "slug">,
): Promise<{ tip: Sha | null; files: DecisionFile[] }> {
  const repo = contextRepoName(repository.slug);
  const tip = await deps.git.resolveRef(repo, BRANCH);
  const commit = tip ? await deps.git.readCommit(repo, tip) : null;
  const root = commit ? await deps.git.readTree(repo, commit.treeSha) : null;
  const directory = root?.find((entry) => entry.name === DECISIONS_DIR && entry.type === "tree");
  const entries = directory ? await deps.git.readTree(repo, directory.sha) : null;

  const files: DecisionFile[] = [];
  for (const entry of entries ?? []) {
    if (entry.type !== "blob" || !entry.name.endsWith(".md")) continue;
    const blob = await deps.git.readBlob(repo, entry.sha);
    if (blob) files.push({ path: `${DECISIONS_DIR}/${entry.name}`, text: decoder.decode(blob) });
  }
  return { tip, files: files.sort((a, b) => (a.path < b.path ? -1 : 1)) };
}
