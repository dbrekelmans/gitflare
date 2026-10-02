import type { ModelAttribution } from "@gitflare/core";
import { ModelError } from "@gitflare/core/ports";
import type { DecisionsDeps } from "./store";

export interface StoredEmbedding {
  embedding: number[] | null;
  embeddingModel: string | null;
}

/** What a decision is found by: its title and its statement. The rationale is not part of its meaning. */
export function embeddingText(decision: { title: string; statement: string }): string {
  return `${decision.title}\n${decision.statement}`;
}

function unit(vector: number[]): number[] {
  const length = Math.hypot(...vector);
  return length === 0 ? vector : vector.map((value) => value / length);
}

/** Cosine similarity of two unit vectors, held to the 0 to 1 the contract promises. */
export function similarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += (a[i] ?? 0) * (b[i] ?? 0);
  return Math.min(1, Math.max(0, dot));
}

/**
 * How many texts one embedding call carries. Workers AI documents no cap per
 * call; this keeps a rebuild of a large record to calls of a modest size.
 */
export const EMBED_BATCH = 64;

/** One unit-length vector per text, in order, in calls of at most `EMBED_BATCH` texts. */
export async function embedTexts(
  deps: Pick<DecisionsDeps, "models">,
  model: string,
  texts: string[],
  attribution: ModelAttribution,
): Promise<number[][]> {
  const vectors: number[][] = [];
  for (let start = 0; start < texts.length; start += EMBED_BATCH) {
    const batch = texts.slice(start, start + EMBED_BATCH);
    const result = await deps.models.embed({ model, texts: batch, attribution });
    if (result.vectors.length !== batch.length) {
      throw new ModelError(
        "invalid_output",
        `asked ${model} for ${batch.length} embeddings and got ${result.vectors.length}`,
      );
    }
    vectors.push(...result.vectors.map(unit));
  }
  return vectors;
}

/**
 * The vector for one decision, or none when the model cannot be reached. A
 * decision is recorded whether or not it could be embedded: retrieval embeds
 * whatever is missing the next time it runs.
 */
export async function embedDecision(
  deps: Pick<DecisionsDeps, "models">,
  model: string,
  decision: { title: string; statement: string },
  attribution: ModelAttribution,
): Promise<StoredEmbedding> {
  try {
    const [embedding] = await embedTexts(deps, model, [embeddingText(decision)], attribution);
    return { embedding: embedding ?? null, embeddingModel: embedding ? model : null };
  } catch (error) {
    if (error instanceof ModelError) return { embedding: null, embeddingModel: null };
    throw error;
  }
}
