import { type ChangeId, decisionApplies, type RepositoryId } from "@gitflare/core";
import type { RetrievedDecision } from "@gitflare/core/ports";
import { schema, toDecision } from "@gitflare/db";
import { and, eq } from "drizzle-orm";
import { embeddingText, embedTexts, similarity } from "./embedding";
import { attribution, type DecisionsDeps, modelSettings, requireRepository } from "./store";

export interface NearestInput {
  repositoryId: RepositoryId;
  query: string;
  limit: number;
  changeId?: ChangeId;
  /** Reviews are never given a dormant decision; learning from a thread has to see them. */
  includeDormant?: boolean;
  /** The files a change touches: a decision tied to paths is a candidate only if it applies to one. */
  paths?: readonly string[];
}

/**
 * The repository's decisions nearest in meaning to `query`. One embedding
 * call covers the query and any decision whose vector is missing or was made
 * by a model the organisation no longer uses; those vectors are stored, so
 * the record repairs itself after a failed embedding or a change of model.
 */
export async function nearestDecisions(
  deps: Pick<DecisionsDeps, "db" | "models">,
  input: NearestInput,
): Promise<RetrievedDecision[]> {
  if (input.limit <= 0) return [];
  const repository = await requireRepository(deps.db, input.repositoryId);
  const all = await deps.db
    .select()
    .from(schema.decisions)
    .where(
      input.includeDormant
        ? eq(schema.decisions.repositoryId, input.repositoryId)
        : and(
            eq(schema.decisions.repositoryId, input.repositoryId),
            eq(schema.decisions.status, "active"),
          ),
    );
  const { paths } = input;
  const rows = paths ? all.filter((row) => decisionApplies(row.scope, paths)) : all;
  if (rows.length === 0) return [];

  const { embedding: model } = await modelSettings(deps.db, repository);
  const stale = rows.filter((row) => !row.embedding || row.embeddingModel !== model);
  const [queryVector, ...fresh] = await embedTexts(
    deps,
    model,
    [input.query, ...stale.map(embeddingText)],
    attribution(input.repositoryId, { changeId: input.changeId }),
  );
  if (!queryVector) return [];

  const vectors = new Map(rows.map((row) => [row.id, row.embedding]));
  for (const [index, row] of stale.entries()) {
    const embedding = fresh[index];
    if (!embedding) continue;
    vectors.set(row.id, embedding);
    await deps.db
      .update(schema.decisions)
      .set({ embedding, embeddingModel: model })
      .where(eq(schema.decisions.id, row.id));
  }

  return rows
    .map((row) => ({
      decision: toDecision(row),
      similarity: similarity(queryVector, vectors.get(row.id) ?? []),
    }))
    .sort((a, b) => b.similarity - a.similarity || b.decision.strength - a.decision.strength)
    .slice(0, input.limit);
}

/**
 * The active decisions of a repository closest in meaning to `query`, nearest
 * first. Dormant decisions are never returned, and with `paths` neither is a
 * decision tied to paths none of which the change touches. Embeds the query,
 * then scans the repository's stored vectors in memory: there is no vector
 * database.
 */
export async function retrieveDecisions(
  deps: Pick<DecisionsDeps, "db" | "models">,
  input: {
    repositoryId: RepositoryId;
    query: string;
    limit: number;
    changeId?: ChangeId;
    paths?: readonly string[];
  },
): Promise<RetrievedDecision[]> {
  const found = await nearestDecisions(deps, { ...input, includeDormant: false });
  const { changeId } = input;
  if (changeId) {
    // A decision the change already follows, cites or contradicts keeps that relation.
    for (const { decision, similarity } of found) {
      await deps.db
        .insert(schema.changeDecisions)
        .values({ changeId, decisionId: decision.id, relation: "retrieved", similarity })
        .onConflictDoUpdate({
          target: [schema.changeDecisions.changeId, schema.changeDecisions.decisionId],
          set: { similarity },
        });
    }
  }
  return found;
}
