import {
  type Change,
  type Decision,
  type DecisionId,
  ForgeError,
  InvalidTransitionError,
  type Thread,
  type ThreadAction,
  type ThreadId,
  type ThreadState,
  transitionThread,
  type User,
  type UserId,
} from "@gitflare/core";
import { ModelError } from "@gitflare/core/ports";
import { appendChangeEvent, schema } from "@gitflare/db";
import { and, eq, isNull } from "drizzle-orm";
import {
  decisionWordingMessage,
  decisionWordingSchema,
  decisionWordingSystem,
} from "./prompts/decision-wording";
import {
  authorsOf,
  clip,
  messagesOf,
  modelSettings,
  type ReviewDeps,
  requireChange,
  requireRepository,
  requireThread,
  type SettleAction,
} from "./store";

const MAX_MESSAGE_CHARS = 4_000;
const MAX_OUTPUT_TOKENS = 600;

/** What the thread becomes, or a `conflict` when the action does not apply to it as it stands. */
export function nextThreadState(thread: Thread, action: ThreadAction): ThreadState {
  try {
    return transitionThread(thread, action);
  } catch (error) {
    if (!(error instanceof InvalidTransitionError)) throw error;
    throw new ForgeError(
      "conflict",
      thread.kind === "chat"
        ? "A chat is not settled; only comments are."
        : `A comment that is ${thread.status} cannot be ${
            {
              resolve: "resolved",
              dismiss: "dismissed",
              reopen: "reopened",
              reclassify: "reclassified",
            }[action.type]
          }.`,
    );
  }
}

/**
 * Moves a thread, as it was read, to its next state, and says so on the
 * change. Returns null when the thread was settled or reopened by someone else
 * in between: the write is refused rather than applied on top of theirs.
 */
export async function applyThreadAction(
  deps: Pick<ReviewDeps, "db" | "live" | "clock" | "decisions">,
  thread: Thread,
  action: ThreadAction,
  by: { userId: UserId | null; decisionId?: DecisionId },
): Promise<Thread | null> {
  const next = nextThreadState(thread, action);
  const open = next.status === "open";
  const [updated] = await deps.db
    .update(schema.threads)
    .set({
      status: next.status,
      dismissal: next.dismissal,
      settledAt: open ? null : deps.clock.now(),
      settledBy: open ? null : by.userId,
      ...(by.decisionId && { decisionId: by.decisionId }),
    })
    .where(
      and(
        eq(schema.threads.id, thread.id),
        eq(schema.threads.status, thread.status),
        thread.dismissal
          ? eq(schema.threads.dismissal, thread.dismissal)
          : isNull(schema.threads.dismissal),
      ),
    )
    .returning();
  if (!updated) return null;
  await appendChangeEvent(deps, thread.changeId, {
    type: "thread.status",
    threadId: thread.id,
    status: next.status,
  });

  // A finding that the change goes against a decision, dismissed because the
  // team means it: the change contradicted that decision and was accepted.
  // Settled any other way, the decision was only cited.
  if (thread.finding?.category === "decision_conflict") {
    const accepted = next.status === "dismissed" && next.dismissal === "design_decision";
    for (const decisionId of thread.finding.decisionIds) {
      await deps.decisions.link({
        changeId: thread.changeId,
        decisionId,
        relation: accepted ? "contradicted" : "cited",
        threadId: thread.id,
      });
    }
  }
  return updated;
}

/** Records the decision a dismissal stands for. */
export async function recordDismissalDecision(
  deps: Pick<ReviewDeps, "decisions">,
  input: {
    thread: Thread;
    change: Pick<Change, "id" | "repositoryId">;
    wording: { title: string; statement: string; rationale: string };
    userId: UserId | null;
  },
): Promise<Decision> {
  return deps.decisions.record({
    repositoryId: input.change.repositoryId,
    ...input.wording,
    globs: [],
    origin: "dismissed_finding",
    changeId: input.change.id,
    threadId: input.thread.id,
    userId: input.userId,
  });
}

/**
 * The decision behind a person's dismissal, worded as a rule. The person's
 * reason is kept as the rationale exactly as given. When the model cannot be
 * reached the dismissal still goes through, with the reason as the statement:
 * a person can reword a decision afterwards.
 */
async function wordDecision(
  deps: Pick<ReviewDeps, "db" | "models">,
  input: { thread: Thread; change: Change; reason: string; userId: UserId },
): Promise<{ title: string; statement: string; rationale: string }> {
  const { thread, change, reason } = input;
  const repository = await requireRepository(deps.db, change.repositoryId);
  const settings = await modelSettings(deps.db, repository);
  const messages = await messagesOf(deps.db, [thread.id]);
  const authors = await authorsOf(deps.db, messages);
  try {
    const reply = await deps.models.generate({
      model: settings.thread,
      system: decisionWordingSystem,
      messages: [
        {
          role: "user",
          content: decisionWordingMessage({
            repositorySlug: repository.slug,
            thread,
            messages: messages.map((message) => ({
              fromPerson: message.author.kind === "user",
              speaker:
                message.author.kind === "user"
                  ? (authors.get(message.author.userId)?.name ?? "someone")
                  : "agent",
              body: clip(message.body, MAX_MESSAGE_CHARS),
            })),
            reason,
          }),
        },
      ],
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      attribution: {
        agent: "thread",
        repositoryId: repository.id,
        changeId: change.id,
        userId: input.userId,
        sessionId: change.sessionId,
      },
      output: { name: "decision_wording", schema: decisionWordingSchema },
    });
    const parsed = decisionWordingSchema.safeParse(reply.output);
    if (!parsed.success) throw new ModelError("invalid_output", parsed.error.message);
    return { ...parsed.data, rationale: reason };
  } catch (error) {
    if (!(error instanceof ModelError)) throw error;
    const subject = thread.finding?.title ?? "A design decision";
    return {
      title: clip(reason.split(/[.\n]/, 1)[0]?.trim() || subject, 120),
      statement: reason || subject,
      rationale: reason,
    };
  }
}

/**
 * A person settling, reclassifying or reopening a comment. A dismissal
 * classified as a design decision records the decision; reclassifying away
 * from that leaves the decision in place for a person to remove.
 *
 * A thread records a decision once. Dismissing it as one again, after a
 * reopening or a reclassification, keeps the decision it already has.
 */
export async function settleThread(
  deps: ReviewDeps,
  user: User,
  threadId: ThreadId,
  action: SettleAction,
): Promise<Thread> {
  const thread = await requireThread(deps.db, threadId);
  const { reason, ...step } = { reason: null, ...action };
  nextThreadState(thread, step);

  let decisionId: DecisionId | undefined;
  const asDecision =
    (action.type === "dismiss" || action.type === "reclassify") &&
    action.classification === "design_decision";
  if (asDecision && !thread.decisionId) {
    const change = await requireChange(deps.db, thread.changeId);
    // A reclassification carries no reason: the last thing a person said in the thread stands for it.
    const said =
      reason ??
      (await messagesOf(deps.db, [threadId])).findLast((m) => m.author.kind === "user")?.body ??
      "";
    const wording = await wordDecision(deps, { thread, change, reason: said, userId: user.id });
    const decision = await recordDismissalDecision(deps, {
      thread,
      change,
      wording,
      userId: user.id,
    });
    decisionId = decision.id;
  }

  const settled = await applyThreadAction(deps, thread, step, { userId: user.id, decisionId });
  if (!settled) {
    throw new ForgeError("conflict", "Someone else settled or reopened this comment just now.");
  }
  // The reason is part of the conversation. The thread is already settled, so
  // the agent, which answers a person's message, has nothing to answer here.
  if (reason !== null) {
    await deps.threads.post(threadId, { author: { kind: "user", userId: user.id }, body: reason });
  }
  return requireThread(deps.db, threadId);
}
