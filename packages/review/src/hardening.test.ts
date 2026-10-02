import { ForgeError, NotImplementedError, type ThreadId } from "@gitflare/core";
import { ModelError, type ModelStreamEvent } from "@gitflare/core/ports";
import { schema } from "@gitflare/db";
import { demo, demoChanges, demoFiles, demoUsers } from "@gitflare/testing/demo";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { appendMessage } from "./messages";
import { learnFromSettledThread, settleThread } from "./settle";
import { runReviewStage } from "./stage";
import { messagesOf, requireThread } from "./store";
import { addThread, demoReview, unreviewed, unreviewedPath } from "./testing/setup";
import { listThreads } from "./threads";
import { runAgentTurn } from "./turn";

// Retries, races and limits: what the first pass got wrong on its failure paths.

const { jonas, priya, maya } = demoUsers;
const change = demoChanges.review;
const rollover: ThreadId = "thr_demo12rollover";
const chat: ThreadId = "thr_demo12queue";
const limiter = "src/invites/rate-limit.ts";

type Review = Awaited<ReturnType<typeof demoReview>>;

const says = (review: Review, threadId: ThreadId, user: typeof jonas, body: string) =>
  appendMessage(review.deps, threadId, { author: { kind: "user", userId: user.id }, body });

const signals = (review: Review, threadId: ThreadId) =>
  review.ports.live.signals.flatMap(({ signal }) =>
    "threadId" in signal && signal.threadId === threadId ? [signal.type] : [],
  );

const conflictThread = async (review: Review) => {
  const [conflicting] = demo.decisions;
  if (!conflicting) throw new Error("the demo has no decision");
  return addThread(
    review.db,
    [
      ["agent", "This fetch has no retry."],
      [jonas, "We never retry inside a request handler."],
    ],
    {
      finding: {
        category: "decision_conflict",
        severity: "important",
        title: "No retry on the billing call",
        decisionIds: [conflicting.id],
      },
    },
  );
};

const asDecision = {
  action: "dismiss_as_decision",
  body: "Dismissed as a design decision.",
  decision: {
    title: "No retries inside request handlers",
    statement: "A request handler never retries an upstream call.",
    rationale: "Retries belong in the queue consumer.",
  },
} as const;

describe("the review stage", () => {
  it("records a clean review, and does not review that revision again", async () => {
    const review = await demoReview();
    const { deps, db, ports } = review;
    ports.models.reply("review", { output: { findings: [], followed: [] } });

    expect(await runReviewStage(deps, unreviewed)).toEqual({ status: "succeeded" });
    expect(
      await db
        .select()
        .from(schema.revisionReviews)
        .where(eq(schema.revisionReviews.revisionId, unreviewed.revisionId)),
    ).toMatchObject([{ attempt: 1, findings: 0, changeId: unreviewed.changeId }]);

    // A retry of the same attempt, and a re-run as a new one: no reply is scripted for either.
    expect(await runReviewStage(deps, unreviewed)).toEqual({ status: "succeeded" });
    expect(await runReviewStage(deps, { ...unreviewed, attempt: 2 })).toEqual({
      status: "succeeded",
    });
    expect(ports.models.calls).toHaveLength(1);
  });

  it("asks the decision record only for decisions that bear on the files the change touches", async () => {
    const { deps, ports } = await demoReview();
    ports.models.reply("review", { output: { findings: [], followed: [] } });
    await runReviewStage(deps, unreviewed);
    expect(ports.decisions.retrievals[0]?.paths).toEqual([unreviewedPath]);
  });
});

describe("the agent's turn", () => {
  it("asks the decision record with the change's paths", async () => {
    const review = await demoReview();
    await says(review, rollover, jonas, "Is that needed?");
    review.ports.models.reply("thread", { output: { action: "reply", body: "Yes." } });
    await runAgentTurn(review.deps, rollover);
    expect(review.ports.decisions.retrievals[0]?.paths).toContain(limiter);
  });

  it("says so in the thread when something other than the model fails, then throws", async () => {
    const review = await demoReview();
    const { deps } = review;
    await says(review, chat, priya, "Is the limit configurable?");
    const failing = {
      ...deps,
      diffs: {
        ...deps.diffs,
        between: () => Promise.reject(new NotImplementedError("@gitflare/diff createDiffs")),
      },
    };

    await expect(runAgentTurn(failing, chat)).rejects.toThrow(NotImplementedError);
    const last = (await messagesOf(deps.db, [chat])).at(-1);
    expect(last).toMatchObject({
      author: { kind: "agent" },
      body: "I could not answer: something went wrong on my side. Write again to have me retry.",
    });
    // The retry that follows a throw finds nothing left to answer.
    expect(await runAgentTurn(failing, chat)).toBeNull();
    expect(await messagesOf(deps.db, [chat])).toHaveLength(4);
  });

  it("discards the draft and says so when a fix cannot be pushed", async () => {
    const review = await demoReview();
    await says(review, rollover, jonas, "Yes, push that.");
    review.ports.models.reply("thread", {
      output: {
        action: "fix",
        body: "Done: pushed.",
        commitMessage: "Fix",
        files: [{ path: limiter, content: `${demoFiles.head[limiter]}\n// fixed\n` }],
      },
    });
    review.git.failNextCommit(new ForgeError("unavailable", "the fork is unreachable"));

    await expect(runAgentTurn(review.deps, rollover)).rejects.toThrow(/unreachable/);
    expect(signals(review, rollover)).toContain("thread.delta");
    expect(signals(review, rollover).at(-1)).toBe("thread.draft_discarded");
    expect((await messagesOf(review.deps.db, [rollover])).at(-1)?.body).toMatch(
      /^I could not answer: something went wrong on my side/,
    );
  });

  it("discards the draft when the model fails halfway through its reply", async () => {
    const review = await demoReview();
    await says(review, chat, priya, "Is the limit configurable?");
    review.ports.models.stream = async function* <T>(): AsyncIterable<ModelStreamEvent<T>> {
      yield { type: "text", text: '{"action":"reply","body":"Not yet' };
      throw new ModelError("unavailable", "the connection dropped");
    };

    const message = await runAgentTurn(review.deps, chat);
    expect(signals(review, chat)).toEqual(["thread.delta", "thread.draft_discarded"]);
    expect(message?.body).toBe(
      "I could not answer: the model is unavailable right now. Write again to have me retry.",
    );
  });

  it("discards the draft when a person writes while it is replying", async () => {
    const review = await demoReview();
    await says(review, chat, priya, "Is the limit configurable?");
    const signal = review.ports.live.signal.bind(review.ports.live);
    let interrupted = false;
    review.ports.live.signal = async (changeId, sent) => {
      if (!interrupted && sent.type === "thread.delta") {
        interrupted = true;
        await says(review, chat, priya, "Per workspace, I mean.");
      }
      return signal(changeId, sent);
    };
    review.ports.models
      .reply("thread", { output: { action: "reply", body: "No, it is one constant." } })
      .reply("thread", { output: { action: "reply", body: "Not per workspace either." } });

    await runAgentTurn(review.deps, chat);
    const sent = signals(review, chat);
    expect(sent).toContain("thread.draft_discarded");
    expect(sent.indexOf("thread.draft_discarded")).toBeLessThan(sent.lastIndexOf("thread.delta"));
  });

  it("posts no stale reply when people keep writing, leaving the newest message to be answered", async () => {
    const review = await demoReview();
    await says(review, chat, priya, "Is the limit configurable?");
    const signal = review.ports.live.signal.bind(review.ports.live);
    let writes = 0;
    review.ports.live.signal = async (changeId, sent) => {
      if (sent.type === "thread.delta" && sent.text.length < 4) {
        await says(review, chat, priya, `And another thing, ${++writes}.`);
      }
      return signal(changeId, sent);
    };
    review.ports.models.respond((request) =>
      request.attribution.agent === "thread"
        ? { output: { action: "reply", body: "An answer to an older question." } }
        : undefined,
    );

    expect(await runAgentTurn(review.deps, chat)).toBeNull();
    const messages = await messagesOf(review.deps.db, [chat]);
    expect(messages.at(-1)).toMatchObject({ author: { kind: "user" } });
    expect(messages.filter((m) => m.body === "An answer to an older question.")).toEqual([]);
    expect(signals(review, chat).at(-1)).toBe("thread.draft_discarded");
  });

  it("records no decision when someone else settles the comment while it is replying", async () => {
    const review = await demoReview();
    const threadId = await conflictThread(review);
    review.ports.models.respond((request) => {
      if (request.attribution.agent !== "thread") return undefined;
      // A person resolves it while the model is still writing.
      void review.db
        .update(schema.threads)
        .set({ status: "resolved", settledAt: demo.now, settledBy: priya.id })
        .where(and(eq(schema.threads.id, threadId), eq(schema.threads.status, "open")))
        .then(() => undefined);
      return { output: asDecision };
    });

    const message = await runAgentTurn(review.deps, threadId);
    expect(message).toMatchObject({ action: null });
    expect(review.ports.decisions.decisions).toHaveLength(demo.decisions.length);
    expect(await requireThread(review.db, threadId)).toMatchObject({
      status: "resolved",
      decisionId: null,
    });
  });

  it("keeps the dismissal when the decision cannot be recorded, and throws for the retry", async () => {
    const review = await demoReview();
    const threadId = await conflictThread(review);
    review.ports.models.reply("thread", { output: asDecision });
    review.ports.decisions.record = () => Promise.reject(new Error("the record is down"));

    await expect(runAgentTurn(review.deps, threadId)).rejects.toThrow(/record is down/);
    expect(await requireThread(review.db, threadId)).toMatchObject({
      status: "dismissed",
      dismissal: "design_decision",
      decisionId: null,
    });
    // The agent's reply is there; no apology follows a reply already given.
    const messages = await messagesOf(review.db, [threadId]);
    expect(messages.at(-1)).toMatchObject({
      author: { kind: "agent" },
      action: { type: "dismissed", classification: "design_decision" },
    });
    expect(review.ports.live.types(change.id)).toContain("thread.status");
  });
});

describe("settleThread", () => {
  it("records no decision when the dismissal loses a race", async () => {
    const review = await demoReview();
    const threadId = await conflictThread(review);
    review.ports.models.respond((request) => {
      if (request.attribution.agent !== "thread") return undefined;
      // Someone resolves it while the decision is being worded, if it is still open.
      void review.db
        .update(schema.threads)
        .set({ status: "resolved", settledAt: demo.now, settledBy: priya.id })
        .where(and(eq(schema.threads.id, threadId), eq(schema.threads.status, "open")))
        .then(() => undefined);
      return { output: asDecision.decision };
    });

    await settleThread(review.deps, maya, threadId, {
      type: "dismiss",
      classification: "design_decision",
      reason: "We never retry inside a request handler.",
    }).catch(() => null);

    // Whichever way the race went, a recorded decision has the dismissal behind it.
    const thread = await requireThread(review.db, threadId);
    const recorded = review.ports.decisions.decisions.filter((d) => d.originThreadId === threadId);
    for (const decision of recorded) {
      expect(thread).toMatchObject({ dismissal: "design_decision", decisionId: decision.id });
    }
  });

  it("keeps the dismissal and the reason when the decision cannot be recorded", async () => {
    const review = await demoReview();
    const threadId = await conflictThread(review);
    review.ports.models.reply("thread", { output: asDecision.decision });
    review.ports.decisions.record = () => Promise.reject(new Error("the record is down"));

    await expect(
      settleThread(review.deps, maya, threadId, {
        type: "dismiss",
        classification: "design_decision",
        reason: "We never retry inside a request handler.",
      }),
    ).rejects.toThrow(/record is down/);
    expect(await requireThread(review.db, threadId)).toMatchObject({
      status: "dismissed",
      dismissal: "design_decision",
      decisionId: null,
    });
    expect(review.ports.threads.list(threadId).map((m) => m.body)).toEqual([
      "We never retry inside a request handler.",
    ]);
  });
});

describe("learnFromSettledThread", () => {
  it("learns from a settled thread and lets a failure out", async () => {
    const review = await demoReview();
    const settled = await addThread(review.db, [[jonas, "Not a problem."]], {
      status: "resolved",
      settledAt: demo.now,
    });
    expect(await learnFromSettledThread(review.deps, rollover)).toBeNull();
    expect(review.ports.decisions.learnedFrom).toEqual([]);

    await learnFromSettledThread(review.deps, settled);
    expect(review.ports.decisions.learnedFrom).toEqual([settled]);

    review.ports.decisions.learnFromThread = () => Promise.reject(new Error("broken record"));
    await expect(learnFromSettledThread(review.deps, settled)).rejects.toThrow(/broken record/);
  });
});

describe("D1's limits", () => {
  it("lists a change with more than a hundred threads", async () => {
    const review = await demoReview({ d1Limits: true });
    const before = (await listThreads(review.deps, change.id)).length;
    for (let i = 0; i < 105; i++) {
      await addThread(review.db, [[i % 2 ? jonas : priya, `Point ${i}`]], { origin: "human" });
    }

    const views = await listThreads(review.deps, change.id);
    expect(views).toHaveLength(before + 105);
    const last = views.find((view) => view.messages[0]?.body === "Point 104");
    expect(last?.messages).toMatchObject([{ body: "Point 104", user: { id: priya.id } }]);
  });
});
