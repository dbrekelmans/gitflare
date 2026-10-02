import {
  type ChangeId,
  can,
  ForgeError,
  type Organisation,
  type OrganisationSettings,
} from "@gitflare/core";
import type { ForgeApi } from "@gitflare/core/api";
import { budgetSummary, monthStart, schema } from "@gitflare/db";
import { eq, gte } from "drizzle-orm";
import type { Services } from "../services";

/**
 * Who is signed in, the members of the deployment, its settings and its AI budget.
 * Build task: `identity`.
 */
export function accountApi(services: Services): ForgeApi["account"] {
  async function organisation(): Promise<Organisation> {
    const [row] = await services.db.select().from(schema.organisations).limit(1);
    if (!row) throw new ForgeError("not_found", "No organisation for this deployment.");
    return row;
  }

  function requireAdmin(user: Parameters<typeof can>[0]): void {
    if (!can(user, { type: "settings.manage" })) {
      throw new ForgeError("forbidden", "Administrators only.");
    }
  }

  return {
    async me(ctx) {
      const org = await organisation();
      return {
        user: ctx.user,
        organisation: { id: org.id, name: org.name, slug: org.slug },
        budget: await budgetSummary(services.db, org.settings, services.clock.now()),
      };
    },

    async listMembers() {
      return services.db.select().from(schema.users);
    },

    async setMemberRole(ctx, input) {
      if (!can(ctx.user, { type: "members.manage" })) {
        throw new ForgeError("forbidden", "Administrators only.");
      }
      const [user] = await services.db
        .update(schema.users)
        .set({ role: input.role })
        .where(eq(schema.users.id, input.userId))
        .returning();
      if (!user) throw new ForgeError("not_found", "User not found.");
      return user;
    },

    async getSettings() {
      return (await organisation()).settings;
    },

    async updateSettings(ctx, input) {
      requireAdmin(ctx.user);
      const org = await organisation();
      const settings: OrganisationSettings = { ...org.settings, ...input };
      await services.db
        .update(schema.organisations)
        .set({ settings })
        .where(eq(schema.organisations.id, org.id));
      return settings;
    },

    async prepareWorkspace(ctx) {
      requireAdmin(ctx.user);
      await services.provisioning.prepareWorkspace();
    },

    async budget() {
      const org = await organisation();
      const start = monthStart(services.clock.now());
      const rows = await services.db
        .select({
          agent: schema.modelCalls.agent,
          costMicroUsd: schema.modelCalls.costMicroUsd,
          changeId: schema.changes.id,
          changeNumber: schema.changes.number,
          changeTitle: schema.changes.title,
        })
        .from(schema.modelCalls)
        .leftJoin(schema.changes, eq(schema.modelCalls.changeId, schema.changes.id))
        .where(gte(schema.modelCalls.createdAt, start));

      const byAgent = new Map<string, number>();
      const byChange = new Map<ChangeId, { number: number; title: string; costMicroUsd: number }>();
      for (const row of rows) {
        byAgent.set(row.agent, (byAgent.get(row.agent) ?? 0) + row.costMicroUsd);
        if (row.changeId) {
          const existing = byChange.get(row.changeId);
          byChange.set(row.changeId, {
            number: row.changeNumber ?? 0,
            title: row.changeTitle ?? "",
            costMicroUsd: (existing?.costMicroUsd ?? 0) + row.costMicroUsd,
          });
        }
      }

      return {
        summary: await budgetSummary(services.db, org.settings, services.clock.now()),
        perChangeBudgetMicroUsd: org.settings.perChangeBudgetMicroUsd,
        byAgent: [...byAgent].map(([agent, costMicroUsd]) => ({ agent, costMicroUsd })),
        topChanges: [...byChange]
          .sort((a, b) => b[1].costMicroUsd - a[1].costMicroUsd)
          .map(([id, { number, title, costMicroUsd }]) => ({
            change: { id, number, title },
            costMicroUsd,
          })),
      };
    },
  };
}
