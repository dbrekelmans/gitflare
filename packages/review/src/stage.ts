import {
  type ChangeId,
  type DecisionId,
  type StageHandler,
  sectionForAnchor,
  type Thread,
  type ThreadAnchor,
  type ThreadMessage,
} from "@gitflare/core";
import { ModelError } from "@gitflare/core/ports";
import { appendChangeEvent, fromThreadMessage, schema } from "@gitflare/db";
import { and, eq, sql } from "drizzle-orm";
import { reviewMessage, reviewOutputSchema, reviewSystem } from "./prompts/review";
import {
  changeThreads,
  commitSubjects,
  currentSections,
  latestIntent,
  modelSettings,
  type ReviewDeps,
  requireChange,
  requireRepository,
  requireRevision,
  requireSession,
  sessionTranscript,
} from "./store";
import { dismissalTally, heldBackCategories } from "./tally";

/** How many decisions a review is given. */
const DECISIONS = 8;
const MAX_QUERY_CHARS = 4_000;
const MAX_OUTPUT_TOKENS = 6_000;

/** Emits `thread.opened` for the threads that have no such event yet: a retry after a lost one. */
async function announce(
  deps: Pick<ReviewDeps, "db" | "live" | "clock">,
  changeId: ChangeId,
  threads: readonly Thread[],
): Promise<void> {
  const opened = await deps.db
    .select({ body: schema.changeEvents.body })
    .from(schema.changeEvents)
    .where(
      and(
        eq(schema.changeEvents.changeId, changeId),
        sql`json_extract(${schema.changeEvents.body}, '$.type') = 'thread.opened'`,
      ),
    );
  const announced = new Set(
    opened.flatMap(({ body }) => (body.type === "thread.opened" ? [body.threadId] : [])),
  );
  for (const thread of threads) {
    if (announced.has(thread.id)) continue;
    await appendChangeEvent(deps, changeId, { type: "thread.opened", threadId: thread.id });
  }
}

/**
 * The review stage. Opens one comment thread per finding, anchored to a file
 * and lines; a thread's section is filled in with `sectionForAnchor` once
 * sections exist. Running it again for the same revision does not duplicate
 * threads.
 *
 * A revision counts as reviewed once it has a finding: the threads and their
 * first messages are written in one batch, so they are all there or none is.
 * A revision reviewed with no findings is reviewed again when asked.
 */
export const runReviewStage: StageHandler<ReviewDeps> = async (deps, input) => {
  const change = await requireChange(deps.db, input.changeId);
  const revision = await requireRevision(deps.db, input.revisionId);
  const existing = await changeThreads(deps.db, change.id);
  const mine = existing.filter(
    (thread) => thread.origin === "review" && thread.anchorRevisionId === revision.id,
  );
  if (mine.length > 0) {
    await announce(deps, change.id, mine);
    return { status: "succeeded" };
  }
  if (change.headRevisionId !== revision.id) {
    return {
      status: "skipped",
      reason: "A newer revision was pushed before this one was reviewed.",
    };
  }

  const repository = await requireRepository(deps.db, change.repositoryId);
  const session = await requireSession(deps.db, change.sessionId);
  const diff = await deps.diffs.between(session.forkRepo, revision.baseSha, revision.headSha);
  if (diff.length === 0) return { status: "skipped", reason: "The revision changes no files." };

  const [intent, commits, transcript, tally, settings] = await Promise.all([
    latestIntent(deps.db, change.id),
    commitSubjects(deps.db, change.id),
    sessionTranscript(deps, change.id),
    dismissalTally(deps, repository.id),
    modelSettings(deps.db, repository),
  ]);
  const paths = diff.map((file) => file.path);
  const retrieved = await deps.decisions.retrieve({
    repositoryId: repository.id,
    query: [change.title, intent?.statement ?? "", ...commits, ...paths]
      .join("\n")
      .slice(0, MAX_QUERY_CHARS),
    limit: DECISIONS,
    changeId: change.id,
  });
  const decisions = retrieved.map((found) => found.decision);
  const heldBack = heldBackCategories(tally);
  const comments = existing.filter((thread) => thread.kind === "comment");

  const outputSchema = reviewOutputSchema({ paths, decisionIds: decisions.map((d) => d.id) });
  const reply = await deps.models.generate({
    model: settings.review,
    system: reviewSystem,
    messages: [
      {
        role: "user",
        content: reviewMessage({
          repositorySlug: repository.slug,
          change,
          revisionNumber: revision.number,
          intent,
          session: transcript,
          commits,
          diff,
          decisions,
          tally,
          heldBack,
          earlier: comments,
        }),
      },
    ],
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    attribution: {
      agent: "review",
      repositoryId: repository.id,
      changeId: change.id,
      userId: change.authorId,
      sessionId: change.sessionId,
    },
    output: { name: "review", schema: outputSchema },
  });
  // The gateway does not guarantee the shape; a reply that is not a review fails the stage.
  const parsed = outputSchema.safeParse(reply.output);
  if (!parsed.success) throw new ModelError("invalid_output", `review: ${parsed.error.message}`);

  const raisedBefore = new Set(
    comments.map((thread) => `${thread.anchor?.path}\n${thread.finding?.title.toLowerCase()}`),
  );
  const findings = parsed.data.findings.filter(
    (finding) =>
      !(finding.severity === "minor" && heldBack.includes(finding.category)) &&
      !raisedBefore.has(`${finding.path}\n${finding.title.toLowerCase()}`),
  );

  const sections = await currentSections(deps.db, change.id);
  const now = deps.clock.now();
  const threads: Thread[] = [];
  const messages: ThreadMessage[] = [];
  for (const finding of findings) {
    const anchor: ThreadAnchor = {
      path: finding.path,
      side: finding.side,
      startLine: finding.startLine,
      endLine: finding.endLine,
    };
    const thread: Thread = {
      id: deps.ids.next("thread"),
      changeId: change.id,
      sectionId: sectionForAnchor(sections, anchor),
      kind: "comment",
      origin: "review",
      status: "open",
      finding: {
        category: finding.category,
        severity: finding.severity,
        title: finding.title,
        decisionIds: [...new Set(finding.decisionIds as DecisionId[])],
      },
      anchor,
      anchorRevisionId: revision.id,
      dismissal: null,
      decisionId: null,
      createdBy: null,
      createdAt: now,
      settledAt: null,
      settledBy: null,
      messageCount: 1,
      lastMessageAt: now,
    };
    threads.push(thread);
    messages.push({
      id: deps.ids.next("message"),
      threadId: thread.id,
      seq: 1,
      author: { kind: "agent" },
      body: finding.body,
      action: null,
      createdAt: now,
    });
  }

  // How the change relates to the decisions it was reviewed against. Written
  // before the threads so that a retry, which reviews again, overwrites them.
  // A decision an earlier comment cited keeps the relation that comment's
  // settling gave it.
  const linked = new Set(comments.flatMap((thread) => thread.finding?.decisionIds ?? []));
  for (const thread of threads) {
    for (const decisionId of thread.finding?.decisionIds ?? []) {
      if (linked.has(decisionId)) continue;
      linked.add(decisionId);
      await deps.decisions.link({
        changeId: change.id,
        decisionId,
        relation: "cited",
        threadId: thread.id,
      });
    }
  }
  for (const decisionId of parsed.data.followed as DecisionId[]) {
    if (linked.has(decisionId)) continue;
    linked.add(decisionId);
    await deps.decisions.link({ changeId: change.id, decisionId, relation: "followed" });
  }

  const [first, ...rest] = [
    ...threads.map((thread) => deps.db.insert(schema.threads).values(thread)),
    ...messages.map((message) =>
      deps.db.insert(schema.threadMessages).values(fromThreadMessage(message)),
    ),
  ];
  if (first) await deps.db.batch([first, ...rest]);
  for (const thread of threads) {
    await appendChangeEvent(deps, change.id, { type: "thread.opened", threadId: thread.id });
  }
  return { status: "succeeded" };
};
