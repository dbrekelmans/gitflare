import { applyDecisionEvent, type Decision, ForgeError, type RepositoryId } from "@gitflare/core";
import { schema } from "@gitflare/db";
import { eq, inArray } from "drizzle-orm";
import { readDecisionFiles } from "./context-repo";
import { embeddingText, embedTexts } from "./embedding";
import { parseDecisionFile } from "./file";
import { attribution, type DecisionsDeps, modelSettings, requireRepository } from "./store";

/**
 * Rebuilds a repository's index from the files in its context repo. The files
 * win: an indexed decision takes its file's wording, strength and times, and a
 * file the index has never seen is added. A decision whose vector no longer
 * matches its words is embedded again. Nothing is removed: a decision with no
 * file stays as it is, and so does every decision's history, which is not in
 * the files.
 *
 * Returns how many files were indexed. A file that cannot be read as a
 * decision does not stop the others; the call fails afterwards, naming each.
 */
export async function reindexDecisions(
  deps: DecisionsDeps,
  repositoryId: RepositoryId,
): Promise<number> {
  const repository = await requireRepository(deps.db, repositoryId);
  const { tip, files } = await readDecisionFiles(deps, repository);
  const problems: string[] = [];

  const parsed = new Map<Decision["id"], Omit<Decision, "repositoryId">>();
  for (const file of files) {
    try {
      const decision = parseDecisionFile(file.path, file.text);
      if (parsed.has(decision.id)) {
        problems.push(`${file.path}: ${decision.id} is also ${parsed.get(decision.id)?.path}`);
      } else {
        parsed.set(decision.id, decision);
      }
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error));
    }
  }

  const ids = [...parsed.keys()];
  const indexed = await deps.db
    .select()
    .from(schema.decisions)
    .where(eq(schema.decisions.repositoryId, repositoryId));
  const elsewhere = ids.length
    ? await deps.db
        .select({ id: schema.decisions.id, repositoryId: schema.decisions.repositoryId })
        .from(schema.decisions)
        .where(inArray(schema.decisions.id, ids))
    : [];
  const byId = new Map(indexed.map((row) => [row.id, row]));
  const byPath = new Map(indexed.map((row) => [row.path, row]));
  for (const [id, decision] of parsed) {
    const holder = byPath.get(decision.path);
    if (elsewhere.some((row) => row.id === id && row.repositoryId !== repositoryId)) {
      problems.push(`${decision.path}: ${id} belongs to another repository`);
      parsed.delete(id);
    } else if (holder && holder.id !== id && !parsed.has(holder.id)) {
      problems.push(
        `${decision.path}: the index has this path as ${holder.id}, the file says ${id}`,
      );
      parsed.delete(id);
    }
  }

  const { embedding: model } = await modelSettings(deps.db, repository);
  const decisions = [...parsed.values()];
  const toEmbed = decisions.filter((decision) => {
    const row = byId.get(decision.id);
    return (
      !row?.embedding ||
      row.embeddingModel !== model ||
      embeddingText(row) !== embeddingText(decision)
    );
  });
  const vectors = await embedTexts(
    deps,
    model,
    toEmbed.map(embeddingText),
    attribution(repositoryId),
  );
  const embedded = new Map(toEmbed.map((decision, index) => [decision.id, vectors[index]]));

  for (const decision of decisions) {
    // The file's strength stands; whether that is dormant is the machine's call, not the file's.
    const { status } = applyDecisionEvent(decision, "reshaped");
    const embedding = embedded.get(decision.id);
    const values = {
      ...decision,
      status,
      repositoryId,
      fileSha: tip,
      ...(embedding && { embedding, embeddingModel: model }),
    };
    await deps.db
      .insert(schema.decisions)
      .values(values)
      .onConflictDoUpdate({ target: schema.decisions.id, set: values });
  }

  if (problems.length > 0) {
    throw new ForgeError(
      "invalid",
      `Indexed ${decisions.length} decision files; could not index:\n${problems.join("\n")}`,
    );
  }
  return decisions.length;
}
