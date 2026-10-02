import {
  type ChangeId,
  type DecisionId,
  defaultModelSettings,
  ForgeError,
  type GitSignature,
  type ModelAttribution,
  type ModelSettings,
  type RepositoryId,
  type UserId,
} from "@gitflare/core";
import type { Clock, GitHost, GitWriter, IdGenerator, ModelGateway } from "@gitflare/core/ports";
import { type Db, schema } from "@gitflare/db";
import { eq } from "drizzle-orm";

export interface DecisionsDeps {
  db: Db;
  git: GitHost;
  gitWriter: GitWriter;
  models: ModelGateway;
  clock: Clock;
  ids: IdGenerator;
}

export type DecisionRow = typeof schema.decisions.$inferSelect;
export type RepositoryRow = typeof schema.repositories.$inferSelect;

/** Who commits decision files to the context repo. */
export const decisionsAuthor: GitSignature = {
  name: "gitflare",
  email: "noreply@gitflare.invalid",
};

export async function requireRepository(
  db: Db,
  repositoryId: RepositoryId,
): Promise<RepositoryRow> {
  const [row] = await db
    .select()
    .from(schema.repositories)
    .where(eq(schema.repositories.id, repositoryId))
    .limit(1);
  if (!row) throw new ForgeError("not_found", `Repository ${repositoryId} does not exist.`);
  return row;
}

export async function requireDecisionRow(db: Db, decisionId: DecisionId): Promise<DecisionRow> {
  const [row] = await db
    .select()
    .from(schema.decisions)
    .where(eq(schema.decisions.id, decisionId))
    .limit(1);
  if (!row) throw new ForgeError("not_found", `Decision ${decisionId} does not exist.`);
  return row;
}

/** The models the repository's organisation has chosen. */
export async function modelSettings(
  db: Db,
  repository: Pick<RepositoryRow, "organisationId">,
): Promise<ModelSettings> {
  const [organisation] = await db
    .select({ settings: schema.organisations.settings })
    .from(schema.organisations)
    .where(eq(schema.organisations.id, repository.organisationId))
    .limit(1);
  return organisation?.settings.models ?? defaultModelSettings;
}

export function attribution(
  repositoryId: RepositoryId,
  extra: { changeId?: ChangeId | null; userId?: UserId | null } = {},
): ModelAttribution {
  return {
    agent: "decisions",
    repositoryId,
    ...(extra.changeId && { changeId: extra.changeId }),
    ...(extra.userId && { userId: extra.userId }),
  };
}
