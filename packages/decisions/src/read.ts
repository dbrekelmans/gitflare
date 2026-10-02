import {
  type Decision,
  type DecisionEvent,
  type DecisionEventId,
  type DecisionId,
  type DecisionStatus,
  ForgeError,
  type RepositoryId,
  type UserId,
} from "@gitflare/core";
import { type Db, schema, toDecision } from "@gitflare/db";
import { and, desc, eq } from "drizzle-orm";
import { writeDecisionEvent } from "./record";
import { type DecisionsDeps, requireDecisionRow } from "./store";

/** A repository's decisions, strongest first. */
export async function listDecisions(
  deps: { db: Db },
  input: { repositoryId: RepositoryId; status?: DecisionStatus },
): Promise<Decision[]> {
  const rows = await deps.db
    .select()
    .from(schema.decisions)
    .where(
      and(
        eq(schema.decisions.repositoryId, input.repositoryId),
        input.status ? eq(schema.decisions.status, input.status) : undefined,
      ),
    )
    .orderBy(desc(schema.decisions.strength), schema.decisions.title);
  return rows.map(toDecision);
}

/** A decision and why it is what it is: its events, newest first. */
export async function decisionHistory(
  deps: { db: Db },
  decisionId: DecisionId,
): Promise<{ decision: Decision; events: DecisionEvent[] }> {
  const row = await requireDecisionRow(deps.db, decisionId);
  const events = await deps.db
    .select()
    .from(schema.decisionEvents)
    .where(eq(schema.decisionEvents.decisionId, decisionId))
    .orderBy(desc(schema.decisionEvents.createdAt), desc(schema.decisionEvents.id));
  return { decision: toDecision(row), events };
}

/**
 * Puts the wording back to what it was before one event reworded it, and
 * records that as an event of its own, so a revert can itself be undone. A
 * decision that already reads that way has nothing to put back: `conflict`.
 */
export async function revertDecision(
  deps: DecisionsDeps,
  input: { decisionId: DecisionId; eventId: DecisionEventId; userId: UserId | null },
): Promise<Decision> {
  const [event] = await deps.db
    .select()
    .from(schema.decisionEvents)
    .where(
      and(
        eq(schema.decisionEvents.id, input.eventId),
        eq(schema.decisionEvents.decisionId, input.decisionId),
      ),
    )
    .limit(1);
  if (!event) throw new ForgeError("not_found", `Decision event ${input.eventId} does not exist.`);
  if (event.wording === null) {
    throw new ForgeError("invalid", "That event did not change the wording.");
  }
  const { decision, applied } = await writeDecisionEvent(deps, input.decisionId, {
    kind: "reverted",
    ...event.wording.before,
    changeId: null,
    threadId: null,
    userId: input.userId,
    note: null,
  });
  if (!applied) {
    throw new ForgeError("conflict", "The decision already reads as it did before that event.");
  }
  return decision;
}
