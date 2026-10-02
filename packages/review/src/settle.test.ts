import type { ThreadId } from "@gitflare/core";
import { schema } from "@gitflare/db";
import { demo, demoChanges, demoUsers } from "@gitflare/testing/demo";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { appendMessage } from "./messages";
import { settleThread } from "./settle";
import { requireThread } from "./store";
import { dismissalTally } from "./tally";
import { addThread, atlas, demoReview } from "./testing/setup";

const { jonas, priya } = demoUsers;
const change = demoChanges.review;
const rollover: ThreadId = "thr_demo12rollover";
const reason =
  "Anything a user can hit gets a fixed window, because support has to say exactly when it resets.";

const windowThread = (db: Awaited<ReturnType<typeof demoReview>>["db"]) =>
  addThread(db, [
    ["agent", "This adds a fixed window where the queue already uses a token bucket."],
    [jonas, "On purpose."],
  ]);

describe("settleThread", () => {
  it("records a decision when a person dismisses a comment as a design decision", async () => {
    const { deps, db, ports } = await demoReview();
    const threadId = await windowThread(db);
    ports.models.reply("thread", {
      output: {
        title: "Fixed windows for limits a user can hit",
        statement:
          "A limit a person can reach uses a fixed window, so its reset time can be stated.",
      },
    });

    const thread = await settleThread(deps, jonas, threadId, {
      type: "dismiss",
      classification: "design_decision",
      reason,
    });

    const recorded = ports.decisions.decisions.at(-1);
    expect(ports.decisions.decisions).toHaveLength(demo.decisions.length + 1);
    expect(recorded).toMatchObject({
      repositoryId: atlas.id,
      title: "Fixed windows for limits a user can hit",
      statement: "A limit a person can reach uses a fixed window, so its reset time can be stated.",
      // The person's reason, exactly as they gave it.
      rationale: reason,
      origin: "dismissed_finding",
      originChangeId: change.id,
      originThreadId: threadId,
    });
    expect(thread).toMatchObject({
      status: "dismissed",
      dismissal: "design_decision",
      decisionId: recorded?.id,
      settledBy: jonas.id,
      settledAt: demo.now,
    });
    expect(ports.live.events).toMatchObject([
      { type: "thread.status", threadId, status: "dismissed" },
    ]);
    // The reason joins the conversation through the thread's writer.
    expect(ports.threads.list(threadId)).toMatchObject([
      { author: { kind: "user", userId: jonas.id }, body: reason },
    ]);
    const prompt = ports.models.calls[0]?.messages[0]?.content ?? "";
    expect(prompt).toContain(`<reason>\n${reason}\n</reason>`);
    expect(prompt).toContain(
      "This adds a fixed window where the queue already uses a token bucket.",
    );
  });

  it("still dismisses when the model cannot word the decision", async () => {
    const { deps, db, ports } = await demoReview();
    const threadId = await windowThread(db);
    ports.models.reply("thread", { error: "budget_exceeded" });

    const thread = await settleThread(deps, jonas, threadId, {
      type: "dismiss",
      classification: "design_decision",
      reason,
    });

    expect(thread).toMatchObject({ status: "dismissed", dismissal: "design_decision" });
    expect(ports.decisions.decisions.at(-1)).toMatchObject({
      id: thread.decisionId,
      title:
        "Anything a user can hit gets a fixed window, because support has to say exactly when it resets",
      statement: reason,
      rationale: reason,
    });
  });

  it("counts a dismissal as not a problem against the category, and records nothing", async () => {
    const { deps, db, ports } = await demoReview();
    const threadId = await windowThread(db);
    const before = await dismissalTally(deps, atlas.id);

    const thread = await settleThread(deps, priya, threadId, {
      type: "dismiss",
      classification: "not_a_problem",
      reason: "Two mechanisms for two different jobs.",
    });

    expect(thread).toMatchObject({
      status: "dismissed",
      dismissal: "not_a_problem",
      decisionId: null,
      settledBy: priya.id,
    });
    expect(ports.models.calls).toHaveLength(0);
    expect(ports.decisions.decisions).toHaveLength(demo.decisions.length);
    expect(await dismissalTally(deps, atlas.id)).toEqual({
      ...before,
      design: { raised: (before.design?.raised ?? 0) + 1, notAProblem: 1 },
    });
  });

  it("records the decision when a dismissal is reclassified as one, and keeps it afterwards", async () => {
    const { deps, db, ports, writer } = await demoReview();
    const threadId = await windowThread(db);
    const wired = { ...deps, threads: writer };
    await settleThread(wired, jonas, threadId, {
      type: "dismiss",
      classification: "not_a_problem",
      reason,
    });
    ports.models.reply("thread", {
      output: { title: "Fixed windows for user-facing limits", statement: "Use a fixed window." },
    });

    const reclassified = await settleThread(wired, jonas, threadId, {
      type: "reclassify",
      classification: "design_decision",
    });

    const recorded = ports.decisions.decisions.at(-1);
    // A reclassification carries no reason: the last thing a person said stands for it.
    expect(recorded).toMatchObject({
      title: "Fixed windows for user-facing limits",
      rationale: reason,
    });
    expect(reclassified).toMatchObject({
      status: "dismissed",
      dismissal: "design_decision",
      decisionId: recorded?.id,
      messageCount: 3,
    });

    // Away again, reopened, and dismissed as a decision once more: one decision throughout.
    const away = await settleThread(wired, jonas, threadId, {
      type: "reclassify",
      classification: "not_a_problem",
    });
    expect(away).toMatchObject({ dismissal: "not_a_problem", decisionId: recorded?.id });
    const reopened = await settleThread(wired, priya, threadId, { type: "reopen" });
    expect(reopened).toMatchObject({
      status: "open",
      dismissal: null,
      settledAt: null,
      settledBy: null,
    });
    await settleThread(wired, jonas, threadId, {
      type: "dismiss",
      classification: "design_decision",
      reason: "As before.",
    });
    expect(ports.decisions.decisions).toHaveLength(demo.decisions.length + 1);
    expect(ports.models.calls).toHaveLength(1);
  });

  it("resolves, and refuses what the thread's state does not allow", async () => {
    const { deps, ports } = await demoReview();

    expect(await settleThread(deps, priya, rollover, { type: "resolve" })).toMatchObject({
      status: "resolved",
      settledBy: priya.id,
    });
    expect(ports.live.types(change.id)).toEqual(["thread.status"]);

    await expect(settleThread(deps, priya, rollover, { type: "resolve" })).rejects.toMatchObject({
      code: "conflict",
    });
    await expect(
      settleThread(deps, priya, "thr_demo12queue", { type: "resolve" }),
    ).rejects.toMatchObject({ code: "conflict", message: expect.stringContaining("chat") });
    await expect(
      settleThread(deps, priya, "thr_nowhere", { type: "resolve" }),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("marks a decision as contradicted when a conflict with it is accepted", async () => {
    const { deps, db, ports } = await demoReview();
    const [decision] = demo.decisions;
    if (!decision) throw new Error("the demo has no decision");
    const threadId = await addThread(db, [["agent", "This goes against a recorded decision."]], {
      finding: {
        category: "decision_conflict",
        severity: "important",
        title: "Logic in the route",
        decisionIds: [decision.id],
      },
      decisionId: "dec_already_recorded",
    });
    const link = { changeId: change.id, decisionId: decision.id, threadId };

    await settleThread(deps, jonas, threadId, {
      type: "dismiss",
      classification: "design_decision",
      reason: "This route is the exception.",
    });
    await settleThread(deps, jonas, threadId, { type: "reopen" });
    await settleThread(deps, jonas, threadId, { type: "resolve" });

    expect(ports.decisions.links).toEqual([
      { ...link, relation: "contradicted" },
      { ...link, relation: "cited" },
      { ...link, relation: "cited" },
    ]);
  });
});

describe("appendMessage", () => {
  it("gives a thread's messages consecutive numbers and keeps its counters", async () => {
    const { deps, db, ports } = await demoReview();
    ports.clock.advance(60_000);

    const stored = await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        appendMessage(deps, rollover, {
          author: index % 2 ? { kind: "agent" } : { kind: "user", userId: jonas.id },
          body: `message ${index}`,
        }),
      ),
    );

    expect(stored.map((message) => message.seq).sort((a, b) => a - b)).toEqual([4, 5, 6, 7, 8, 9]);
    const rows = await db
      .select()
      .from(schema.threadMessages)
      .where(eq(schema.threadMessages.threadId, rollover));
    expect(rows.map((row) => row.seq).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(rows.find((row) => row.id === stored[0]?.id)).toMatchObject({
      seq: stored[0]?.seq,
      authorKind: "user",
      authorUserId: jonas.id,
      body: "message 0",
      createdAt: demo.now + 60_000,
    });
    expect(await requireThread(db, rollover)).toMatchObject({
      messageCount: 9,
      lastMessageAt: demo.now + 60_000,
    });
    expect(ports.live.types(change.id)).toEqual(Array(6).fill("thread.message"));
  });

  it("refuses a thread that does not exist", async () => {
    const { deps } = await demoReview();
    await expect(
      appendMessage(deps, "thr_nowhere", { author: { kind: "agent" }, body: "hello" }),
    ).rejects.toMatchObject({ code: "not_found" });
  });
});
