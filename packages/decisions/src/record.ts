import {
  applyDecisionEvent,
  type ChangeId,
  type Decision,
  type DecisionEvent,
  type DecisionEventKind,
  type DecisionId,
  type DecisionOrigin,
  decisionWording,
  ForgeError,
  initialDecisionState,
  type ThreadId,
} from "@gitflare/core";
import type { NewDecision } from "@gitflare/core/ports";
import { schema, toDecision } from "@gitflare/db";
import { and, eq, getTableColumns, inArray, sql } from "drizzle-orm";
import { syncDecisionFiles } from "./context-repo";
import { embedDecision } from "./embedding";
import { cleanTitle, DECISIONS_DIR, decisionPath } from "./file";
import {
  attribution,
  type DecisionRow,
  type DecisionsDeps,
  modelSettings,
  requireDecisionRow,
  requireRepository,
} from "./store";

const ATTEMPTS = 4;

const createdNote: Record<DecisionOrigin, string | null> = {
  dismissed_finding: "Recorded from a dismissed review comment.",
  review_reply: "Learned from a reply in review.",
  chat: "Learned from a conversation about a change.",
  change: null,
  manual: null,
};

async function freePath(deps: DecisionsDeps, input: NewDecision, id: DecisionId): Promise<string> {
  for (let attempt = 1; ; attempt++) {
    const path = decisionPath(input.title, attempt);
    // A title with nothing a path can hold is filed under its id.
    if (!path) return `${DECISIONS_DIR}/${id.toLowerCase().replace("_", "-")}.md`;
    const [taken] = await deps.db
      .select({ id: schema.decisions.id })
      .from(schema.decisions)
      .where(
        and(eq(schema.decisions.repositoryId, input.repositoryId), eq(schema.decisions.path, path)),
      )
      .limit(1);
    if (!taken) return path;
  }
}

/** Writes the decision's file to the context repo, indexes and embeds it, and records `created`. */
export async function recordDecision(deps: DecisionsDeps, input: NewDecision): Promise<Decision> {
  const repository = await requireRepository(deps.db, input.repositoryId);
  const title = cleanTitle(input.title);
  const statement = input.statement.trim();
  const rationale = input.rationale.trim();
  if (!title || !statement) {
    throw new ForgeError("invalid", "A decision needs a title and a statement.");
  }

  // The same words from the same thread are the same decision: a caller that
  // is retried gets the one it recorded the first time.
  if (input.threadId) {
    const [existing] = await deps.db
      .select()
      .from(schema.decisions)
      .where(
        and(
          eq(schema.decisions.repositoryId, input.repositoryId),
          eq(schema.decisions.originThreadId, input.threadId),
          eq(schema.decisions.statement, statement),
        ),
      )
      .limit(1);
    if (existing) {
      await syncDecisionFiles(deps, repository, [existing.id], `Record decision: ${title}`);
      return toDecision(existing);
    }
  }

  const id = deps.ids.next("decision");
  const now = deps.clock.now();
  const state = applyDecisionEvent(initialDecisionState(), "created");
  const { embedding: model } = await modelSettings(deps.db, repository);
  const embedding = await embedDecision(
    deps,
    model,
    { title, statement },
    attribution(input.repositoryId, input),
  );
  const decision: Decision = {
    id,
    repositoryId: input.repositoryId,
    path: await freePath(deps, { ...input, title }, id),
    title,
    statement,
    rationale,
    scope: input.globs.length > 0 ? { kind: "paths", globs: input.globs } : { kind: "general" },
    ...state,
    origin: input.origin,
    originChangeId: input.changeId,
    originThreadId: input.threadId,
    createdAt: now,
    updatedAt: now,
  };
  const event: DecisionEvent = {
    id: deps.ids.next("decisionEvent"),
    decisionId: id,
    kind: "created",
    changeId: input.changeId,
    threadId: input.threadId,
    userId: input.userId,
    strengthBefore: state.strength,
    strengthAfter: state.strength,
    wording: null,
    note: createdNote[input.origin],
    createdAt: now,
  };
  await deps.db.batch([
    deps.db.insert(schema.decisions).values({ ...decision, ...embedding, fileSha: null }),
    deps.db.insert(schema.decisionEvents).values(event),
  ]);
  await syncDecisionFiles(deps, repository, [id], `Record decision: ${title}`);
  return decision;
}

export type DecisionEventInput = Pick<
  DecisionEvent,
  "kind" | "changeId" | "threadId" | "userId" | "note"
> & {
  /** New wording, for `reshaped` and `reverted`. */
  statement?: string;
  title?: string;
  rationale?: string;
};

const rewording: readonly DecisionEventKind[] = ["reshaped", "reverted"];

/**
 * Applies one event in the index, and says whether anything was written. The
 * event row and the decision's new state are written together, and only if
 * the decision still is what was read: an event that lost a race is applied
 * again to what the winner left.
 */
async function applyEvent(
  deps: DecisionsDeps,
  decisionId: DecisionId,
  input: DecisionEventInput,
): Promise<{ row: DecisionRow; applied: boolean }> {
  if (input.kind === "created") {
    throw new ForgeError("invalid", "A decision is created once, by recording it.");
  }
  const { decisions, decisionEvents } = schema;
  for (let attempt = 1; ; attempt++) {
    const row = await requireDecisionRow(deps.db, decisionId);
    if (input.kind === "revived" && row.status !== "dormant") {
      throw new ForgeError("invalid", "Only a dormant decision can be revived.");
    }

    const rewords = rewording.includes(input.kind);
    const wording = {
      title: rewords && input.title !== undefined ? cleanTitle(input.title) : row.title,
      statement: rewords && input.statement !== undefined ? input.statement.trim() : row.statement,
      rationale: rewords && input.rationale !== undefined ? input.rationale.trim() : row.rationale,
    };
    if (!wording.title || !wording.statement) {
      throw new ForgeError("invalid", "A decision needs a title and a statement.");
    }
    const meaningMoved = wording.title !== row.title || wording.statement !== row.statement;
    // Rewording a decision to the words it already has is not an event.
    if (rewords && !meaningMoved && wording.rationale === row.rationale) {
      return { row, applied: false };
    }

    const next = applyDecisionEvent({ strength: row.strength, status: row.status }, input.kind);
    const now = deps.clock.now();
    const event: DecisionEvent = {
      id: deps.ids.next("decisionEvent"),
      decisionId,
      kind: input.kind,
      changeId: input.changeId,
      threadId: input.threadId,
      userId: input.userId,
      strengthBefore: row.strength,
      strengthAfter: next.strength,
      wording: rewords ? { before: decisionWording(row), after: wording } : null,
      note: input.note,
      createdAt: now,
    };
    let embedding = { embedding: row.embedding, embeddingModel: row.embeddingModel };
    if (meaningMoved) {
      const repository = await requireRepository(deps.db, row.repositoryId);
      const { embedding: model } = await modelSettings(deps.db, repository);
      embedding = await embedDecision(deps, model, wording, attribution(row.repositoryId, input));
    }

    const unchanged = and(
      eq(decisions.id, decisionId),
      eq(decisions.strength, row.strength),
      eq(decisions.title, row.title),
      eq(decisions.statement, row.statement),
      eq(decisions.rationale, row.rationale),
    );
    const eventValues = Object.entries(getTableColumns(decisionEvents)).map(([name, column]) => {
      const value = event[name as keyof DecisionEvent];
      // This insert bypasses Drizzle's own encoding, so a JSON column is encoded here.
      return sql`${value === null ? null : column.mapToDriverValue(value)}`;
    });
    const [, updated] = await deps.db.batch([
      deps.db
        .insert(decisionEvents)
        .select(sql`select ${sql.join(eventValues, sql`, `)} from ${decisions} where ${unchanged}`),
      deps.db
        .update(decisions)
        .set({ ...wording, ...next, ...embedding, updatedAt: now })
        .where(unchanged)
        .returning({ id: decisions.id }),
    ]);
    if (updated.length > 0) {
      return {
        row: { ...row, ...wording, ...next, ...embedding, updatedAt: now },
        applied: true,
      };
    }
    if (attempt === ATTEMPTS) {
      throw new ForgeError("conflict", `Decision ${decisionId} kept changing; try again.`);
    }
  }
}

function commitMessage(kind: DecisionEventKind, title: string): string {
  switch (kind) {
    case "reshaped":
      return `Reword decision: ${title}`;
    case "reverted":
      return `Revert decision wording: ${title}`;
    case "revived":
      return `Revive decision: ${title}`;
    case "contradiction_accepted":
      return `Weaken decision: ${title}`;
    default:
      return `Reinforce decision: ${title}`;
  }
}

/**
 * Applies one event to a decision: moves its strength and status, rewrites the
 * file, and stores the event. Every change to a decision goes through here.
 */
export async function recordDecisionEvent(
  deps: DecisionsDeps,
  decisionId: DecisionId,
  event: DecisionEventInput,
): Promise<Decision> {
  const { row } = await applyEvent(deps, decisionId, event);
  const repository = await requireRepository(deps.db, row.repositoryId);
  // Also when nothing was applied: an earlier attempt may have stopped before the file was written.
  await syncDecisionFiles(deps, repository, [row.id], commitMessage(event.kind, row.title));
  return toDecision(row);
}

/** Records how a change related to a decision it was reviewed against. The latest word stands. */
export async function linkDecision(
  deps: Pick<DecisionsDeps, "db">,
  input: {
    changeId: ChangeId;
    decisionId: DecisionId;
    relation: "followed" | "cited" | "contradicted";
    threadId?: ThreadId;
  },
): Promise<void> {
  await requireDecisionRow(deps.db, input.decisionId);
  const threadId = input.threadId ?? null;
  await deps.db
    .insert(schema.changeDecisions)
    .values({ ...input, threadId, similarity: 0 })
    .onConflictDoUpdate({
      target: [schema.changeDecisions.changeId, schema.changeDecisions.decisionId],
      set: { relation: input.relation, threadId },
    });
}

const settledAs = {
  followed: "followed",
  cited: "cited",
  contradicted: "contradiction_accepted",
} as const satisfies Record<string, DecisionEventKind>;

/**
 * Called when a change merges: every decision the change followed or cited is
 * reinforced, and every one it contradicted — and merged anyway — is weakened.
 * A decision that was only retrieved is left as it was. Safe to call again:
 * a change settles each decision once.
 */
export async function settleChangeDecisions(
  deps: DecisionsDeps,
  changeId: ChangeId,
): Promise<void> {
  const links = await deps.db
    .select()
    .from(schema.changeDecisions)
    .where(eq(schema.changeDecisions.changeId, changeId));
  const settling = links.flatMap((link) =>
    link.relation === "retrieved" ? [] : [{ ...link, kind: settledAs[link.relation] }],
  );
  if (settling.length === 0) return;

  const [change] = await deps.db
    .select({ repositoryId: schema.changes.repositoryId, number: schema.changes.number })
    .from(schema.changes)
    .where(eq(schema.changes.id, changeId))
    .limit(1);
  if (!change) throw new ForgeError("not_found", `Change ${changeId} does not exist.`);
  const repository = await requireRepository(deps.db, change.repositoryId);

  const decisionIds = settling.map((link) => link.decisionId);
  const settled = await deps.db
    .select({ decisionId: schema.decisionEvents.decisionId })
    .from(schema.decisionEvents)
    .where(
      and(
        eq(schema.decisionEvents.changeId, changeId),
        inArray(schema.decisionEvents.decisionId, decisionIds),
        inArray(schema.decisionEvents.kind, Object.values(settledAs)),
      ),
    );
  const done = new Set(settled.map((event) => event.decisionId));

  for (const link of settling) {
    if (done.has(link.decisionId)) continue;
    await applyEvent(deps, link.decisionId, {
      kind: link.kind,
      changeId,
      threadId: link.threadId,
      userId: null,
      note: null,
    });
  }
  await syncDecisionFiles(
    deps,
    repository,
    decisionIds,
    `Settle decisions for change #${change.number}`,
  );
}
