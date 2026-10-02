import {
  type Decision,
  type DecisionId,
  ForgeError,
  type ThreadId,
  type UserId,
} from "@gitflare/core";
import { ModelError } from "@gitflare/core/ports";
import { schema, toDecision } from "@gitflare/db";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import {
  learnFromThreadMessage,
  learnFromThreadSystem,
  threadLessonSchema,
} from "./prompts/learn-from-thread";
import { recordDecision, recordDecisionEvent } from "./record";
import { nearestDecisions } from "./retrieve";
import {
  attribution,
  type DecisionsDeps,
  modelSettings,
  requireDecisionRow,
  requireRepository,
} from "./store";

/** How many existing decisions the model is shown. */
const CANDIDATES = 6;
/** A long thread keeps its first message and its newest ones. */
const MAX_MESSAGES = 40;
const MAX_MESSAGE_CHARS = 4_000;
const MAX_OUTPUT_TOKENS = 1_200;

/** The decision this thread was already learned from, if it was. */
async function alreadyLearned(deps: DecisionsDeps, threadId: ThreadId): Promise<Decision | null> {
  const events = await deps.db
    .select({ decisionId: schema.decisionEvents.decisionId, kind: schema.decisionEvents.kind })
    .from(schema.decisionEvents)
    .where(
      and(
        eq(schema.decisionEvents.threadId, threadId),
        inArray(schema.decisionEvents.kind, ["created", "confirmed"]),
      ),
    )
    .orderBy(desc(schema.decisionEvents.createdAt));
  for (const event of events) {
    const row = await requireDecisionRow(deps.db, event.decisionId);
    // A decision recorded by dismissing the thread was not learned from reading it.
    if (event.kind === "confirmed" || row.origin !== "dismissed_finding") return toDecision(row);
  }
  return null;
}

/**
 * Looks through a settled thread for a decision worth keeping, and records or
 * reinforces it. Returns the decision the thread produced or touched, or null
 * when it decided nothing. Safe to call again: a thread is learned from once.
 */
export async function learnFromThread(
  deps: DecisionsDeps,
  threadId: ThreadId,
): Promise<Decision | null> {
  const [thread] = await deps.db
    .select()
    .from(schema.threads)
    .where(eq(schema.threads.id, threadId))
    .limit(1);
  if (!thread) throw new ForgeError("not_found", `Thread ${threadId} does not exist.`);
  // Dismissing a comment as a design decision records it there and then.
  if (thread.dismissal === "design_decision" && thread.decisionId) return null;

  const learned = await alreadyLearned(deps, threadId);
  if (learned) return learned;

  const all = await deps.db
    .select()
    .from(schema.threadMessages)
    .where(eq(schema.threadMessages.threadId, threadId))
    .orderBy(asc(schema.threadMessages.seq));
  // Only a person can decide something: a thread nobody answered has nothing to learn from.
  const lastPerson = all.findLast((message) => message.authorKind === "user");
  if (!lastPerson) return null;
  const userId: UserId | null = lastPerson.authorUserId;

  const [change] = await deps.db
    .select()
    .from(schema.changes)
    .where(eq(schema.changes.id, thread.changeId))
    .limit(1);
  if (!change) throw new ForgeError("not_found", `Change ${thread.changeId} does not exist.`);
  const repository = await requireRepository(deps.db, change.repositoryId);

  const kept = all.length > MAX_MESSAGES ? [all[0], ...all.slice(1 - MAX_MESSAGES)] : all;
  const authorIds = [...new Set(kept.flatMap((m) => (m?.authorUserId ? [m.authorUserId] : [])))];
  const authors = authorIds.length
    ? await deps.db
        .select({ id: schema.users.id, name: schema.users.name })
        .from(schema.users)
        .where(inArray(schema.users.id, authorIds))
    : [];
  const names = new Map(authors.map((user) => [user.id, user.name]));
  const messages = kept.flatMap((message) =>
    message
      ? [
          {
            fromPerson: message.authorKind === "user",
            speaker:
              message.authorKind === "user"
                ? ((message.authorUserId && names.get(message.authorUserId)) ?? "someone")
                : "agent",
            body:
              message.body.length > MAX_MESSAGE_CHARS
                ? `${message.body.slice(0, MAX_MESSAGE_CHARS)}\n[cut short]`
                : message.body,
          },
        ]
      : [],
  );

  const settings = await modelSettings(deps.db, repository);
  const who = attribution(repository.id, { changeId: change.id, userId });
  const query = [thread.finding?.title ?? "", ...messages.map((message) => message.body)]
    .join("\n")
    .slice(0, 8_000);
  const existing = (
    await nearestDecisions(deps, {
      repositoryId: repository.id,
      query,
      limit: CANDIDATES,
      changeId: change.id,
      includeDormant: true,
    })
  ).map((found) => found.decision);

  const lessonSchema = threadLessonSchema(existing.map((decision) => decision.id));
  const reply = await deps.models.generate({
    model: settings.decisions,
    system: learnFromThreadSystem,
    messages: [
      {
        role: "user",
        content: learnFromThreadMessage({
          repositorySlug: repository.slug,
          change,
          thread,
          messages,
          existing,
        }),
      },
    ],
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    attribution: who,
    output: { name: "thread_lesson", schema: lessonSchema },
  });
  // The port promises a validated object; the record is not written on a promise.
  const parsed = lessonSchema.safeParse(reply.output);
  if (!parsed.success) {
    throw new ModelError("invalid_output", `thread lesson: ${parsed.error.message}`);
  }
  const lesson = parsed.data;

  const source = { changeId: change.id, threadId, userId };
  switch (lesson.outcome) {
    case "none":
      return null;
    case "new":
      return recordDecision(deps, {
        repositoryId: repository.id,
        title: lesson.title,
        statement: lesson.statement,
        rationale: lesson.rationale,
        globs: [],
        origin: thread.kind === "chat" ? "chat" : "review_reply",
        ...source,
      });
    case "confirms":
      return recordDecisionEvent(deps, lesson.decisionId as DecisionId, {
        kind: "confirmed",
        note: lesson.note,
        ...source,
      });
    case "reshapes": {
      const decisionId = lesson.decisionId as DecisionId;
      await recordDecisionEvent(deps, decisionId, {
        kind: "reshaped",
        title: lesson.title,
        statement: lesson.statement,
        rationale: lesson.rationale,
        note: lesson.note,
        ...source,
      });
      // A conversation that rewords a decision has also stood by it. This is
      // written last: it is what marks the thread as learned from.
      return recordDecisionEvent(deps, decisionId, {
        kind: "confirmed",
        note: null,
        ...source,
      });
    }
  }
}
