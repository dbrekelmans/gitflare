import type { ThreadId } from "@gitflare/core";
import { schema } from "@gitflare/db";
import { demo, demoChanges, demoFiles, demoUsers } from "@gitflare/testing/demo";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { appendMessage } from "./messages";
import { learnFromSettledThread } from "./settle";
import { messagesOf, requireThread } from "./store";
import { addThread, atlas, demoReview } from "./testing/setup";
import { bodySoFar, runAgentTurn } from "./turn";

const { jonas, priya } = demoUsers;
const change = demoChanges.review;
/** The demo's open comment: the agent proposed a fix and asked whether to push it. */
const rollover: ThreadId = "thr_demo12rollover";
const chat: ThreadId = "thr_demo12queue";
const limiter = "src/invites/rate-limit.ts";

type Review = Awaited<ReturnType<typeof demoReview>>;

const says = (review: Review, threadId: ThreadId, user: typeof jonas, body: string) =>
  appendMessage(review.deps, threadId, { author: { kind: "user", userId: user.id }, body });

const drafts = (review: Review, threadId: ThreadId) =>
  review.ports.live.signals.flatMap(({ changeId, signal }) =>
    changeId === change.id && signal.type === "thread.delta" && signal.threadId === threadId
      ? [signal.text]
      : [],
  );

describe("runAgentTurn", () => {
  it("replies to a person, streaming the reply as it is written", async () => {
    const review = await demoReview();
    const { deps, ports } = review;
    await says(review, chat, priya, "And why a Durable Object rather than KV?");
    const body =
      'Jonas asked for that in the session: "Keep the counter out of KV".\n\nIt is also a recorded decision: **Counters live in Durable Objects, not KV**.';
    ports.models.reply("thread", { output: { action: "reply", body } });

    const message = await runAgentTurn(deps, chat);

    expect(message).toMatchObject({
      threadId: chat,
      seq: 4,
      author: { kind: "agent" },
      body,
      action: null,
    });
    expect((await messagesOf(deps.db, [chat])).at(-1)).toEqual(message);
    // Each signal is the reply so far, in full; the last one is the whole reply.
    const texts = drafts(review, chat);
    expect(texts.length).toBeGreaterThan(5);
    expect(texts.at(-1)).toBe(body);
    texts.forEach((text, index) => {
      expect(body.startsWith(text)).toBe(true);
      expect(text.length).toBeGreaterThan(texts[index - 1]?.length ?? 0);
    });
    expect(ports.live.types(change.id).slice(-2)).toEqual(["thread.message", "thread.message"]);
  });

  it("is given the thread, the session, the nearest decisions and the files as they are", async () => {
    const review = await demoReview();
    const { deps, ports } = review;
    await says(review, rollover, jonas, "Yes, do that.");
    ports.models.reply("thread", { output: { action: "reply", body: "On it." } });
    await runAgentTurn(deps, rollover);

    const [call] = ports.models.calls;
    expect(call).toMatchObject({
      model: demo.organisation.settings.models.thread,
      attribution: {
        agent: "thread",
        repositoryId: atlas.id,
        changeId: change.id,
        userId: jonas.id,
      },
    });
    const prompt = call?.messages[0]?.content ?? "";
    expect(prompt).toContain("finding: Nothing tests the window rolling over (tests, important)");
    expect(prompt).toContain(
      '<message from="person" name="Jonas Lindqvist" role="author of the change">\nYes, do that.\n</message>',
    );
    expect(prompt).toContain('<message from="agent" name="agent">\n`takeInviteSlot` could take');
    expect(prompt).toContain("Keep the counter out of KV");
    expect(prompt).toContain(`<file path="${limiter}">\n${demoFiles.head[limiter]}`);
    expect(ports.decisions.retrievals).toMatchObject([{ repositoryId: atlas.id, limit: 5 }]);
    expect(ports.decisions.retrievals[0]).not.toHaveProperty("changeId");
    const [nearest] = await ports.decisions.retrieve({
      repositoryId: atlas.id,
      query: ports.decisions.retrievals[0]?.query ?? "",
      limit: 1,
    });
    expect(prompt).toContain(`<decision id="${nearest?.decision.id}">`);
    // Jonas owns the session, so a fix is on offer; it is a comment, so settling is too.
    expect(call?.system).toContain('"action": "fix"');
    expect(call?.system).toContain('"action": "dismiss_as_decision"');
  });

  it("commits a requested fix to the fork", async () => {
    const review = await demoReview();
    const { deps, ports, git, repos } = review;
    const fork = repos.forks.review;
    const tip = await git.resolveRef(fork, "rate-limit-invites");
    await says(review, rollover, jonas, "Yes, push that.");
    const rewritten = `${demoFiles.head[limiter]}\n// now takes the time as an argument\n`;
    const test =
      'import { it } from "vitest";\n\nit("allows a workspace again in the next hour");\n';
    ports.models.reply("thread", {
      output: {
        action: "fix",
        body: "Done: `takeInviteSlot` takes the current time, and a test crosses the hour. Pushed to your fork.",
        commitMessage: "Take the current time as an argument",
        files: [
          { path: limiter, content: rewritten },
          { path: "test/invites/rollover.test.ts", content: test },
        ],
      },
    });

    const message = await runAgentTurn(deps, rollover);

    const head = await git.resolveRef(fork, "rate-limit-invites");
    expect(head).not.toBe(tip);
    expect(message).toMatchObject({
      author: { kind: "agent" },
      action: { type: "pushed_fix", sha: head },
    });
    expect(await git.text(fork, "rate-limit-invites", limiter)).toBe(rewritten);
    expect(await git.text(fork, "rate-limit-invites", "test/invites/rollover.test.ts")).toBe(test);
    expect(await git.readCommit(fork, head ?? "")).toMatchObject({
      parents: [tip],
      message: "Take the current time as an argument\n\nRequested in review of change #12.",
      author: { name: "gitflare" },
    });
    expect(git.pushes.at(-1)).toMatchObject({
      repoName: fork,
      ref: "refs/heads/rate-limit-invites",
      before: tip,
      after: head,
    });
    // The author settles it once they have seen the new revision.
    expect(await requireThread(deps.db, rollover)).toMatchObject({ status: "open" });
  });

  it("pushes nothing for someone who does not own the session", async () => {
    const review = await demoReview();
    const { deps, ports, git, repos } = review;
    const tip = await git.resolveRef(repos.forks.review, "rate-limit-invites");
    await says(review, rollover, priya, "Just push the fix.");
    ports.models.reply("thread", {
      output: {
        action: "fix",
        body: "Done.",
        commitMessage: "Fix",
        files: [{ path: limiter, content: "export {};\n" }],
      },
    });

    const message = await runAgentTurn(deps, rollover);

    expect(ports.models.calls[0]?.system).not.toContain('"action": "fix"');
    expect(await git.resolveRef(repos.forks.review, "rate-limit-invites")).toBe(tip);
    expect(message).toMatchObject({ action: null });
    expect(message?.body).toMatch(
      /^I could not answer: the model's answer was not one I can act on/,
    );
  });

  it("refuses a fix that overwrites a file it was never shown", async () => {
    const review = await demoReview();
    const { deps, ports, git, repos } = review;
    const tip = await git.resolveRef(repos.forks.review, "rate-limit-invites");
    const untouched = "src/invites/email.ts";
    expect(await git.text(repos.forks.review, "rate-limit-invites", untouched)).not.toBeNull();
    await says(review, rollover, jonas, "Yes, push that.");
    ports.models.reply("thread", {
      output: {
        action: "fix",
        body: "Done.",
        commitMessage: "Rewrite the email sender",
        files: [{ path: untouched, content: "export {};\n" }],
      },
    });

    const message = await runAgentTurn(deps, rollover);

    expect(await git.resolveRef(repos.forks.review, "rate-limit-invites")).toBe(tip);
    expect(message?.body).toMatch(/^I could not do that/);
    expect(message?.action).toBeNull();
  });

  it("resolves a comment on a person's word, and offers the thread to the decision record", async () => {
    const review = await demoReview();
    const { deps, ports } = review;
    await says(review, rollover, jonas, "The second test already crosses the hour, look again.");
    ports.models.reply("thread", {
      output: { action: "resolve", body: "You are right, it does. I have resolved this." },
    });

    const message = await runAgentTurn(deps, rollover);

    expect(message).toMatchObject({ action: { type: "resolved" } });
    expect(await requireThread(deps.db, rollover)).toMatchObject({
      status: "resolved",
      dismissal: null,
      settledBy: jonas.id,
      settledAt: demo.now,
    });
    expect(ports.live.events.slice(-2)).toMatchObject([
      { type: "thread.status", threadId: rollover, status: "resolved" },
      { type: "thread.message", threadId: rollover },
    ]);
    // Learning is the thread's writer's next step, after the turn.
    expect(ports.decisions.learnedFrom).toEqual([]);
    await learnFromSettledThread(deps, rollover);
    expect(ports.decisions.learnedFrom).toEqual([rollover]);
    expect(ports.decisions.decisions).toHaveLength(demo.decisions.length);
  });

  it("records a decision when it dismisses a comment as a design decision", async () => {
    const review = await demoReview();
    const { deps, db, ports } = review;
    const [conflicting] = demo.decisions;
    if (!conflicting) throw new Error("the demo has no decision");
    const threadId = await addThread(
      db,
      [
        ["agent", "This fetch has no retry. A transient 503 fails the whole request."],
        [jonas, "We never retry inside a request handler. Retries belong in the queue consumer."],
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
    ports.models.reply("thread", {
      output: {
        action: "dismiss_as_decision",
        body: "Understood. I have dismissed this as a design decision and recorded it: **No retries inside request handlers**.",
        decision: {
          title: "No retries inside request handlers",
          statement:
            "A request handler never retries an upstream call. Retries happen in the queue consumer.",
          rationale: "Retries belong in the queue consumer.",
        },
      },
    });

    const message = await runAgentTurn(deps, threadId);

    const recorded = ports.decisions.decisions.at(-1);
    expect(ports.decisions.decisions).toHaveLength(demo.decisions.length + 1);
    expect(recorded).toMatchObject({
      repositoryId: atlas.id,
      title: "No retries inside request handlers",
      rationale: "Retries belong in the queue consumer.",
      origin: "dismissed_finding",
      originChangeId: change.id,
      originThreadId: threadId,
      scope: { kind: "general" },
    });
    expect(await requireThread(deps.db, threadId)).toMatchObject({
      status: "dismissed",
      dismissal: "design_decision",
      decisionId: recorded?.id,
      settledBy: jonas.id,
    });
    expect(message).toMatchObject({
      action: { type: "dismissed", classification: "design_decision" },
    });
    // The change went against a decision and the team accepted that.
    expect(ports.decisions.links).toEqual([
      { changeId: change.id, decisionId: conflicting.id, relation: "contradicted", threadId },
    ]);
    // Recording it there and then is the learning; the thread is not read again for one.
    expect(ports.decisions.learnedFrom).toEqual([]);
  });

  it("dismisses as not a problem without recording anything", async () => {
    const review = await demoReview();
    const { deps, db, ports } = review;
    const threadId = await addThread(db, [
      ["agent", "This helper duplicates `formatDate`."],
      [jonas, "It does not: that one is locale-aware and this is for log lines."],
    ]);
    ports.models.reply("thread", {
      output: { action: "dismiss", body: "I misread it. Dismissed." },
    });

    const message = await runAgentTurn(deps, threadId);

    expect(message).toMatchObject({
      action: { type: "dismissed", classification: "not_a_problem" },
    });
    expect(await requireThread(deps.db, threadId)).toMatchObject({
      status: "dismissed",
      dismissal: "not_a_problem",
      decisionId: null,
    });
    expect(ports.decisions.decisions).toHaveLength(demo.decisions.length);
    await learnFromSettledThread(deps, threadId);
    expect(ports.decisions.learnedFrom).toEqual([threadId]);
  });

  it("does not settle a chat", async () => {
    const review = await demoReview();
    const { deps, ports } = review;
    await says(review, chat, priya, "Fine, resolve this.");
    ports.models.reply("thread", { output: { action: "resolve", body: "Resolved." } });

    const message = await runAgentTurn(deps, chat);

    expect(ports.models.calls[0]?.system).not.toContain('"action": "resolve"');
    expect(message?.body).toMatch(/^I could not answer/);
    expect(await requireThread(deps.db, chat)).toMatchObject({ status: "open" });
  });

  it("does nothing where it has no part, or nothing to answer", async () => {
    const review = await demoReview();
    const { deps, db, ports } = review;
    const between = await addThread(db, [[priya, "Should this be behind the flag?"]], {
      origin: "human",
      finding: null,
      createdBy: priya.id,
    });
    const settled = await addThread(
      db,
      [
        ["agent", "A point."],
        [jonas, "Not a problem."],
      ],
      {
        status: "dismissed",
        dismissal: "not_a_problem",
      },
    );

    // A comment between people; a thread whose last word is the agent's; a settled one.
    expect(await runAgentTurn(deps, between)).toBeNull();
    expect(await runAgentTurn(deps, rollover)).toBeNull();
    expect(await runAgentTurn(deps, settled)).toBeNull();

    await says(review, rollover, jonas, "Yes.");
    await db
      .update(schema.changes)
      .set({ status: "merged" })
      .where(eq(schema.changes.id, change.id));
    expect(await runAgentTurn(deps, rollover)).toBeNull();
    expect(ports.models.calls).toHaveLength(0);
  });

  it("answers once, harmlessly, when the same turn is run again", async () => {
    const review = await demoReview();
    const { deps, ports } = review;
    await says(review, chat, priya, "Thanks. Is the limit configurable?");
    ports.models.reply("thread", {
      output: { action: "reply", body: "Not yet: it is a constant." },
    });

    expect(await runAgentTurn(deps, chat)).not.toBeNull();
    expect(await runAgentTurn(deps, chat)).toBeNull();
    expect(ports.models.calls).toHaveLength(1);
    expect(await messagesOf(deps.db, [chat])).toHaveLength(4);
  });

  it("says so in the thread when the model cannot answer", async () => {
    const review = await demoReview();
    const { deps, ports } = review;
    await says(review, chat, priya, "Is the limit configurable?");
    ports.models.reply("thread", { error: "budget_exceeded" });

    const message = await runAgentTurn(deps, chat);

    expect(message).toMatchObject({
      author: { kind: "agent" },
      action: null,
      body: "I could not answer: the model budget is spent. Write again to have me retry.",
    });
  });

  it("starts over when a person writes while it is replying", async () => {
    const review = await demoReview();
    const { deps, ports } = review;
    await says(review, chat, priya, "Is the limit configurable?");
    const signal = ports.live.signal.bind(ports.live);
    let interrupted = false;
    ports.live.signal = async (changeId, sent) => {
      if (!interrupted) {
        interrupted = true;
        await says(review, chat, priya, "Per workspace, I mean.");
      }
      return signal(changeId, sent);
    };
    ports.models
      .reply("thread", { output: { action: "reply", body: "No, it is one constant." } })
      .reply("thread", { output: { action: "reply", body: "Not per workspace either." } });

    const message = await runAgentTurn(deps, chat);

    expect(ports.models.calls).toHaveLength(2);
    expect(ports.models.calls[1]?.messages[0]?.content).toContain("Per workspace, I mean.");
    expect(message).toMatchObject({ seq: 5, body: "Not per workspace either." });
    expect((await messagesOf(deps.db, [chat])).map((m) => m.author.kind)).toEqual([
      "user",
      "agent",
      "user",
      "user",
      "agent",
    ]);
  });
});

describe("bodySoFar", () => {
  it("reads the body out of a reply that is still arriving", () => {
    const whole = JSON.stringify({ action: "reply", body: 'Use "x"\nnot \\y: é 👍', files: [] });
    let last = "";
    for (let end = 0; end <= whole.length; end++) {
      const text = bodySoFar(whole.slice(0, end));
      expect(text.startsWith(last)).toBe(true);
      last = text;
    }
    expect(last).toBe('Use "x"\nnot \\y: é 👍');
    expect(bodySoFar('{"action":"reply","body":"caf\\u00')).toBe("caf");
    expect(bodySoFar('{"action":"reply"')).toBe("");
  });
});
