import type { DecisionId } from "@gitflare/core";
import { ModelError } from "@gitflare/core/ports";
import { schema, toDecision } from "@gitflare/db";
import { demo, demoChanges, demoUsers } from "@gitflare/testing/demo";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { learnFromThread } from "./learn";
import { decisionHistory } from "./read";
import { addThread, atlas, demoRecord } from "./testing/setup";

const { jonas, priya } = demoUsers;

const retryThread: Parameters<typeof addThread>[1] = [
  [
    "agent",
    "This fetch has no retry. A transient 503 from the billing API fails the whole request.",
  ],
  [
    jonas,
    "We never retry inside a request handler. Retries belong in the queue consumer, where a slow upstream cannot hold a connection open.",
  ],
  ["agent", "Understood. Resolving."],
];

const momentThread: Parameters<typeof addThread>[1] = [
  ["agent", "This formats a date by hand. The repository has used moment for date handling."],
  [priya, "Keep using moment to format and compare dates here; we are not migrating this quarter."],
];

/** The record as people see it. Vectors are left out: looking for candidates fills in missing ones. */
async function snapshot(db: Awaited<ReturnType<typeof demoRecord>>["db"]) {
  return {
    decisions: (await db.select().from(schema.decisions)).map(toDecision),
    events: await db.select().from(schema.decisionEvents),
  };
}

describe("learnFromThread", () => {
  it("records a decision a person made in a review reply", async () => {
    const { deps, db, ports, file } = await demoRecord();
    const threadId = await addThread(db, retryThread);
    ports.models.reply("decisions", {
      output: {
        outcome: "new",
        title: "No retries inside request handlers",
        statement:
          "A request handler never retries an upstream call. Retries happen in the queue consumer.",
        rationale: "A slow upstream must not hold a connection open.",
        note: "Jonas ruled out a retry the reviewer asked for.",
      },
    });

    const decision = await learnFromThread(deps, threadId);
    expect(decision).toMatchObject({
      repositoryId: atlas.id,
      title: "No retries inside request handlers",
      origin: "review_reply",
      originChangeId: demoChanges.review.id,
      originThreadId: threadId,
      strength: 0.5,
      status: "active",
    });
    expect(await file(decision?.path ?? "")).toContain("# No retries inside request handlers");
    const { events } = await decisionHistory(deps, decision?.id as DecisionId);
    expect(events).toMatchObject([
      { kind: "created", userId: jonas.id, threadId, changeId: demoChanges.review.id },
    ]);
  });

  it("gives the model the thread, who said what, and the nearest existing decisions", async () => {
    const { deps, db, ports } = await demoRecord();
    const threadId = await addThread(db, momentThread);
    ports.models.reply("decisions", { output: { outcome: "none" } });
    await learnFromThread(deps, threadId);

    const [call] = ports.models.calls;
    expect(ports.models.calls).toHaveLength(1);
    expect(call).toMatchObject({
      model: demo.organisation.settings.models.decisions,
      attribution: {
        agent: "decisions",
        repositoryId: atlas.id,
        changeId: demoChanges.review.id,
        userId: priya.id,
      },
    });
    expect(call?.system).toContain('{"outcome": "none"}');
    const prompt = call?.messages[0]?.content ?? "";
    expect(prompt).toContain(`change: #${demoChanges.review.number} ${demoChanges.review.title}`);
    expect(prompt).toContain('<message from="agent" name="agent">\nThis formats a date by hand.');
    expect(prompt).toContain('<message from="person" name="Priya Raman">\nKeep using moment');
    // Learning sees dormant decisions too, or it would record a second copy of one.
    expect(prompt).toContain('<decision id="dec_moment_for_dates" status="dormant">');
    expect(prompt).toContain("statement: Format and compare dates with moment.");
  });

  it("reinforces an existing decision a person stood by, which can bring a dormant one back", async () => {
    const { deps, db, ports } = await demoRecord();
    const threadId = await addThread(db, momentThread);
    ports.models.reply("decisions", {
      output: {
        outcome: "confirms",
        decisionId: "dec_moment_for_dates",
        note: "Priya asked for moment to stay.",
      },
    });

    const decision = await learnFromThread(deps, threadId);
    // confirmed: a quarter of the way from 0.11 to 1.
    expect(decision).toMatchObject({ id: "dec_moment_for_dates", status: "active" });
    expect(decision?.strength).toBeCloseTo(0.3325, 10);
    const { events } = await decisionHistory(deps, "dec_moment_for_dates");
    expect(events[0]).toMatchObject({
      kind: "confirmed",
      threadId,
      userId: priya.id,
      note: "Priya asked for moment to stay.",
      statementBefore: null,
    });
  });

  it("rewords a decision a person changed, and counts that as standing by it", async () => {
    const { deps, db, ports, file } = await demoRecord();
    const threadId = await addThread(db, [
      ["agent", "This logs the webhook signing secret at debug level."],
      [jonas, "Signing secrets count too: log the id of any credential, never its value."],
    ]);
    const statement =
      "Log the id of a token, invite or signing secret, never its value, at any log level.";
    ports.models.reply("decisions", {
      output: {
        outcome: "reshapes",
        decisionId: "dec_no_secrets_in_logs",
        title: "Never log credentials",
        statement,
        rationale: "An invite code in a log line was replayed from a shared dashboard in March.",
        note: "Widened to signing secrets after a reply in review.",
      },
    });

    const decision = await learnFromThread(deps, threadId);
    expect(decision).toMatchObject({ title: "Never log credentials", statement });
    // 0.83, confirmed.
    expect(decision?.strength).toBeCloseTo(0.8725, 10);
    expect(await file("decisions/no-secrets-in-logs.md")).toContain(statement);
    const { events } = await decisionHistory(deps, "dec_no_secrets_in_logs");
    expect(events.slice(0, 2)).toMatchObject([
      { kind: "confirmed", threadId },
      {
        kind: "reshaped",
        threadId,
        statementBefore: "Log the id of a token or invite, never its value, at any log level.",
        statementAfter: statement,
        note: "Widened to signing secrets after a reply in review.",
        strengthBefore: 0.83,
        strengthAfter: 0.83,
      },
    ]);
  });

  it("learns from a thread once", async () => {
    const { deps, db, ports } = await demoRecord();
    const threadId = await addThread(db, retryThread);
    ports.models.reply("decisions", {
      output: {
        outcome: "new",
        title: "No retries inside request handlers",
        statement: "A request handler never retries an upstream call.",
        rationale: "",
        note: "Jonas ruled out a retry.",
      },
    });
    const first = await learnFromThread(deps, threadId);
    const after = await snapshot(db);

    // No reply is scripted for a second call: asking the model again would fail.
    expect(await learnFromThread(deps, threadId)).toEqual(first);
    expect(await snapshot(db)).toEqual(after);
    expect(ports.models.calls).toHaveLength(1);
  });

  it("leaves the record alone when the thread decided nothing", async () => {
    const { deps, db, ports } = await demoRecord();
    const before = await snapshot(db);
    const threadId = await addThread(db, retryThread);
    ports.models.reply("decisions", { output: { outcome: "none" } });
    expect(await learnFromThread(deps, threadId)).toBeNull();
    expect(await snapshot(db)).toEqual(before);
  });

  it.each([
    [
      "names a decision it was not shown",
      { outcome: "confirms", decisionId: "dec_made_up", note: "x" },
    ],
    ["leaves out the statement", { outcome: "new", title: "A rule", rationale: "", note: "x" }],
    ["invents an outcome", { outcome: "maybe" }],
    ["is not an object", "none"],
  ])("fails, writing nothing, when the reply %s", async (_what, output) => {
    const { deps, db, ports } = await demoRecord();
    const before = await snapshot(db);
    const threadId = await addThread(db, retryThread);
    ports.models.reply("decisions", { output });
    await expect(learnFromThread(deps, threadId)).rejects.toThrow(ModelError);
    expect(await snapshot(db)).toEqual(before);
  });

  it("does not ask the model about a thread no person spoke in", async () => {
    const { deps, db, ports } = await demoRecord();
    const threadId = await addThread(db, [["agent", "This fetch has no retry."]]);
    expect(await learnFromThread(deps, threadId)).toBeNull();
    expect(ports.models.calls).toEqual([]);
  });

  it("does not learn again from a comment whose dismissal already recorded a decision", async () => {
    const { deps, db, ports } = await demoRecord();
    const [thread] = await db
      .select()
      .from(schema.threads)
      .where(eq(schema.threads.id, "thr_demo12window"));
    expect(thread).toMatchObject({ dismissal: "design_decision", decisionId: "dec_fixed_windows" });
    expect(await learnFromThread(deps, "thr_demo12window")).toBeNull();
    expect(ports.models.calls).toEqual([]);
  });

  it("records what a chat decided as coming from a chat", async () => {
    const { deps, ports } = await demoRecord();
    ports.models.reply("decisions", {
      output: {
        outcome: "new",
        title: "Caps are checked before the insert",
        statement:
          "A limit on how many records can be created is checked before the insert, not by delaying what follows it.",
        rationale: "",
        note: "Priya accepted the agent's explanation of why the queue's limiter was not reused.",
      },
    });
    const decision = await learnFromThread(deps, "thr_demo12queue");
    expect(decision).toMatchObject({
      origin: "chat",
      originThreadId: "thr_demo12queue",
      rationale: "",
    });
  });
});
