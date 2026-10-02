import type { FindingCategory, RepositoryId } from "@gitflare/core";
import { schema } from "@gitflare/db";
import { and, eq, ne } from "drizzle-orm";
import type { DismissalTally, ReviewDeps } from "./store";

/** A category needs this many settled findings before its record counts against it. */
const MIN_SETTLED = 4;

/**
 * How often each category of finding has been dismissed as "not a problem" in
 * a repository, against how often it was raised. The review stage reads this
 * before it writes findings: a category people keep dismissing is raised less
 * readily, and the prompt is told so. Counted from settled threads; there is
 * no separate tally to keep in step.
 */
export async function dismissalTally(
  deps: Pick<ReviewDeps, "db">,
  repositoryId: RepositoryId,
): Promise<DismissalTally> {
  const rows = await deps.db
    .select({ finding: schema.threads.finding, dismissal: schema.threads.dismissal })
    .from(schema.threads)
    .innerJoin(schema.changes, eq(schema.threads.changeId, schema.changes.id))
    .where(
      and(
        eq(schema.changes.repositoryId, repositoryId),
        eq(schema.threads.origin, "review"),
        ne(schema.threads.status, "open"),
      ),
    );
  const tally: DismissalTally = {};
  for (const row of rows) {
    if (!row.finding) continue;
    const entry = tally[row.finding.category] ?? { raised: 0, notAProblem: 0 };
    entry.raised++;
    if (row.dismissal === "not_a_problem") entry.notAProblem++;
    tally[row.finding.category] = entry;
  }
  return tally;
}

/**
 * The categories whose minor findings are no longer shown: at least half of
 * what was raised and settled in them was dismissed as not a problem.
 */
export function heldBackCategories(tally: DismissalTally): FindingCategory[] {
  return (Object.entries(tally) as [FindingCategory, { raised: number; notAProblem: number }][])
    .filter(([, count]) => count.raised >= MIN_SETTLED && count.notAProblem * 2 >= count.raised)
    .map(([category]) => category);
}
