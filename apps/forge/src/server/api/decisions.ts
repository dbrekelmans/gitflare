import { can, type DecisionId, ForgeError, type RepositoryId } from "@gitflare/core";
import type { ApiContext, DecisionDetail, ForgeApi } from "@gitflare/core/api";
import { schema } from "@gitflare/db";
import {
  decisionHistory,
  listDecisions,
  recordDecision,
  recordDecisionEvent,
  revertDecision,
} from "@gitflare/decisions";
import { eq, inArray } from "drizzle-orm";
import type { Services } from "../services";

/**
 * A repository's decision record: reading it, correcting it, reverting and reviving.
 * Build task: `decisions`.
 */
export function decisionsApi(services: Services): ForgeApi["decisions"] {
  const allow = (ctx: ApiContext, type: "repository.read" | "decision.edit") => {
    if (!can(ctx.user, { type })) {
      throw new ForgeError("forbidden", "You may not do that to the decision record.");
    }
  };
  const repositoryId = async (slug: string): Promise<RepositoryId> => {
    const [repository] = await services.db
      .select({ id: schema.repositories.id })
      .from(schema.repositories)
      .where(eq(schema.repositories.slug, slug))
      .limit(1);
    if (!repository) throw new ForgeError("not_found", `Repository ${slug} does not exist.`);
    return repository.id;
  };
  /** A decision's history, with the repository it belongs to and the people behind its events. */
  const detail = async (decisionId: DecisionId): Promise<DecisionDetail> => {
    const { decision, events } = await decisionHistory(services, decisionId);
    const [repository] = await services.db
      .select({ id: schema.repositories.id, slug: schema.repositories.slug })
      .from(schema.repositories)
      .where(eq(schema.repositories.id, decision.repositoryId))
      .limit(1);
    if (!repository) throw new ForgeError("not_found", "Repository not found.");
    const ids = [...new Set(events.flatMap((event) => (event.userId ? [event.userId] : [])))];
    const people = new Map<string, DecisionDetail["events"][number]["user"]>();
    // D1 binds at most 100 parameters to a statement.
    for (let i = 0; i < ids.length; i += 90) {
      const rows = await services.db
        .select({ id: schema.users.id, name: schema.users.name, email: schema.users.email })
        .from(schema.users)
        .where(inArray(schema.users.id, ids.slice(i, i + 90)));
      for (const row of rows) people.set(row.id, row);
    }
    return {
      decision,
      repository,
      events: events.map((event) => ({
        ...event,
        user: (event.userId && people.get(event.userId)) || null,
      })),
    };
  };
  // What a person does to a decision carries their id and nothing else.
  const by = (ctx: ApiContext) => ({
    userId: ctx.user.id,
    changeId: null,
    threadId: null,
    note: null,
  });

  return {
    async list(ctx, input) {
      allow(ctx, "repository.read");
      return listDecisions(services, {
        repositoryId: await repositoryId(input.repoSlug),
        status: input.status,
      });
    },
    async get(ctx, input) {
      allow(ctx, "repository.read");
      return detail(input.decisionId);
    },
    async create(ctx, input) {
      allow(ctx, "decision.edit");
      const decision = await recordDecision(services, {
        repositoryId: await repositoryId(input.repoSlug),
        title: input.title,
        statement: input.statement,
        rationale: input.rationale,
        globs: input.globs,
        origin: "manual",
        ...by(ctx),
      });
      return detail(decision.id);
    },
    async edit(ctx, input) {
      allow(ctx, "decision.edit");
      const { decisionId, ...wording } = input;
      await recordDecisionEvent(services, decisionId, { kind: "reshaped", ...wording, ...by(ctx) });
      return detail(decisionId);
    },
    async revert(ctx, input) {
      allow(ctx, "decision.edit");
      await revertDecision(services, { ...input, userId: ctx.user.id });
      return detail(input.decisionId);
    },
    async revive(ctx, input) {
      allow(ctx, "decision.edit");
      await recordDecisionEvent(services, input.decisionId, { kind: "revived", ...by(ctx) });
      return detail(input.decisionId);
    },
  };
}
