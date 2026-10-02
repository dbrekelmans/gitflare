import type {
  AgentName,
  BudgetSummary,
  ChangeCost,
  ChangeId,
  OrganisationSettings,
  Timestamp,
} from "@gitflare/core";
import { eq, gte, sql } from "drizzle-orm";
import type { Db } from "./index";
import { modelCalls } from "./schema";

/** What gitflare's agents have spent on one change, by agent. A sum over `model_calls`. */
export async function changeCost(db: Db, changeId: ChangeId): Promise<ChangeCost> {
  const rows = await db
    .select({ agent: modelCalls.agent, total: sql<number>`sum(${modelCalls.costMicroUsd})` })
    .from(modelCalls)
    .where(eq(modelCalls.changeId, changeId))
    .groupBy(modelCalls.agent);
  const byAgent: Partial<Record<AgentName, number>> = {};
  let totalMicroUsd = 0;
  for (const row of rows) {
    byAgent[row.agent] = row.total;
    totalMicroUsd += row.total;
  }
  return { changeId, totalMicroUsd, byAgent, estimated: true };
}

/** The first instant of the UTC calendar month containing `now`. */
export function monthStart(now: Timestamp): Timestamp {
  const date = new Date(now);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
}

/** The deployment's spend this calendar month against its budget. */
export async function budgetSummary(
  db: Db,
  settings: Pick<OrganisationSettings, "monthlyBudgetMicroUsd">,
  now: Timestamp,
): Promise<BudgetSummary> {
  const start = monthStart(now);
  const [row] = await db
    .select({ total: sql<number | null>`sum(${modelCalls.costMicroUsd})` })
    .from(modelCalls)
    .where(gte(modelCalls.createdAt, start));
  return {
    monthStart: start,
    budgetMicroUsd: settings.monthlyBudgetMicroUsd,
    spentMicroUsd: row?.total ?? 0,
  };
}
