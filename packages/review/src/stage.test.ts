import type { Section } from "@gitflare/core";
import { ModelError } from "@gitflare/core/ports";
import { schema } from "@gitflare/db";
import { demo, demoChanges, demoUsers } from "@gitflare/testing/demo";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { runReviewStage } from "./stage";
import { changeThreads, messagesOf } from "./store";
import { dismissalTally } from "./tally";
import { addThread, atlas, demoReview, unreviewed, unreviewedPath } from "./testing/setup";

const { jonas } = demoUsers;
const changeId = demoChanges.cloud.id;
const active = demo.decisions.filter((decision) => decision.status === "active");
const dormant = demo.decisions.filter((decision) => decision.status === "dormant");

const unbounded = {
  category: "performance",
  severity: "important",
  title: "The export reads the whole audit log into memory",
  body: "`exportAuditLog` selects every row for the workspace and joins them into one string. A workspace with years of history will exhaust the Worker's memory. Page through the rows and stream the response.",
  path: unreviewedPath,
  side: "head",
  startLine: 4,
  endLine: 8,
  decisionIds: [],
} as const;

const unescaped = {
  category: "correctness",
  severity: "blocking",
  title: "Commas in an action break the CSV",
  body: "The fields are joined with commas and never quoted, so an action containing a comma shifts every later column.",
  path: unreviewedPath,
  side: "head",
  startLine: 9,
  endLine: 9,
  decisionIds: [],
} as const;

const reviewThreads = async (db: Awaited<ReturnType<typeof demoReview>>["db"]) =>
  (await changeThreads(db, changeId)).filter((thread) => thread.origin === "review");

describe("runReviewStage", () => {
  it("opens one anchored comment per finding, with the finding as its first message", async () => {
    const { deps, db, ports } = await demoReview();
    const section: Section & { removedAt: null } = {
      id: "sec_test_export",
      changeId,
      position: 0,
      title: "Export the audit log",
      kind: "behaviour",
      explanation: "",
      files: [{ path: unreviewedPath, hunkHashes: [] }],
      contentHash: "hash",
      createdRevisionId: unreviewed.revisionId,
      updatedRevisionId: unreviewed.revisionId,
      removedAt: null,
    };
    await db.insert(schema.sections).values(section);
    ports.models.reply("review", { output: { findings: [unescaped, unbounded], followed: [] } });

    expect(await runReviewStage(deps, unreviewed)).toEqual({ status: "succeeded" });

    const threads = await reviewThreads(db);
    expect(threads).toMatchObject([
      {
        kind: "comment",
        status: "open",
        sectionId: section.id,
        finding: { category: "correctness", severity: "blocking", title: unescaped.title },
        anchor: { path: unreviewedPath, side: "head", startLine: 9, endLine: 9 },
        anchorRevisionId: unreviewed.revisionId,
        createdBy: null,
        messageCount: 1,
      },
      { finding: { category: "performance" }, anchor: { startLine: 4, endLine: 8 } },
    ]);
    const messages = await messagesOf(
      db,
      threads.map((thread) => thread.id),
    );
    expect(messages).toMatchObject([
      { seq: 1, author: { kind: "agent" }, body: unescaped.body, action: null },
      { seq: 1, author: { kind: "agent" }, body: unbounded.body, action: null },
    ]);
    expect(
      ports.live.events.filter((event) => event.type === "thread.opened").map((e) => e.threadId),
    ).toEqual(threads.map((thread) => thread.id));
  });

  it("is given the decisions the record retrieves, and says how the change relates to them", async () => {
    const { deps, ports } = await demoReview();
    const [followed, cited] = active;
    if (!followed || !cited) throw new Error("the demo has too few decisions");
    ports.capture.set({
      changeId,
      missingCheckpointIds: [],
      sessions: [
        {
          changeId,
          agentSessionId: "session-13",
          agent: "Claude Code",
          model: null,
          checkpointIds: [],
          turns: [{ kind: "prompt", text: "Add a CSV export of the audit log.", at: null }],
          attribution: null,
        },
      ],
    });
    ports.models.reply("review", {
      output: {
        findings: [
          { ...unbounded, category: "decision_conflict", decisionIds: [cited.id] },
          unescaped,
        ],
        followed: [followed.id, cited.id],
      },
    });

    await runReviewStage(deps, unreviewed);

    expect(ports.decisions.retrievals).toMatchObject([
      { repositoryId: atlas.id, changeId, limit: 8 },
    ]);
    expect(ports.decisions.retrievals[0]?.query).toContain(demoChanges.cloud.title);
    const [call] = ports.models.calls;
    expect(call).toMatchObject({
      model: demo.organisation.settings.models.review,
      attribution: { agent: "review", repositoryId: atlas.id, changeId },
    });
    const prompt = call?.messages[0]?.content ?? "";
    for (const decision of active) {
      expect(prompt).toContain(`<decision id="${decision.id}">`);
      expect(prompt).toContain(decision.statement);
    }
    for (const decision of dormant) expect(prompt).not.toContain(decision.statement);
    // The session that made the change, and the change itself with its line numbers.
    expect(prompt).toContain("[prompt] Add a CSV export of the audit log.");
    expect(prompt).toContain(`<file path="${unreviewedPath}" status="added">`);
    expect(prompt).toMatch(/\n +3 \+ export async function exportAuditLog/);

    const [conflict] = await changeThreads(deps.db, changeId);
    expect(conflict?.finding?.decisionIds).toEqual([cited.id]);
    expect(ports.decisions.links).toEqual([
      { changeId, decisionId: cited.id, relation: "cited", threadId: conflict?.id },
      { changeId, decisionId: followed.id, relation: "followed" },
    ]);
  });

  it("does nothing the second time it runs for a revision", async () => {
    const { deps, db, ports } = await demoReview();
    ports.models.reply("review", { output: { findings: [unescaped, unbounded], followed: [] } });
    await runReviewStage(deps, unreviewed);
    const before = {
      threads: await reviewThreads(db),
      messages: await db.select().from(schema.threadMessages),
      events: await db.select().from(schema.changeEvents),
    };

    // No reply is scripted: a second call to the model would fail the test.
    expect(await runReviewStage(deps, unreviewed)).toEqual({ status: "succeeded" });
    expect(await runReviewStage(deps, { ...unreviewed, attempt: 2 })).toEqual({
      status: "succeeded",
    });

    expect(ports.models.calls).toHaveLength(1);
    expect(await reviewThreads(db)).toEqual(before.threads);
    expect(await db.select().from(schema.threadMessages)).toEqual(before.messages);
    expect(await db.select().from(schema.changeEvents)).toEqual(before.events);
  });

  it("announces a thread whose event was lost before the first run finished", async () => {
    const { deps, db, ports } = await demoReview();
    const lost = await addThread(db, [["agent", "Raised, then the step died."]], {
      changeId,
      anchor: { path: unreviewedPath, side: "head", startLine: 1, endLine: 1 },
      anchorRevisionId: unreviewed.revisionId,
    });

    await runReviewStage(deps, unreviewed);

    expect(ports.models.calls).toHaveLength(0);
    expect(ports.live.events).toMatchObject([{ type: "thread.opened", threadId: lost }]);
  });

  it("fails on a reply that is not a review", async () => {
    const { deps, db, ports } = await demoReview();
    ports.models.reply("review", { text: "Looks good to me." });
    await expect(runReviewStage(deps, unreviewed)).rejects.toBeInstanceOf(ModelError);

    ports.models.reply("review", {
      output: { findings: [{ ...unescaped, path: "src/elsewhere.ts" }], followed: [] },
    });
    await expect(runReviewStage(deps, unreviewed)).rejects.toMatchObject({
      code: "invalid_output",
    });

    ports.models.reply("review", {
      output: { findings: [{ ...unescaped, decisionIds: ["dec_invented"] }], followed: [] },
    });
    await expect(runReviewStage(deps, unreviewed)).rejects.toMatchObject({
      code: "invalid_output",
    });
    expect(await reviewThreads(db)).toEqual([]);
  });

  it("does not repeat a comment an earlier revision already has", async () => {
    const { deps, db, ports } = await demoReview();
    await addThread(db, [["agent", unescaped.body]], {
      changeId,
      status: "dismissed",
      dismissal: "not_a_problem",
      finding: { ...unescaped, decisionIds: [] },
      anchor: { path: unreviewedPath, side: "head", startLine: 9, endLine: 9 },
      anchorRevisionId: "rev_earlier",
    });
    ports.models.reply("review", { output: { findings: [unescaped, unbounded], followed: [] } });

    await runReviewStage(deps, unreviewed);

    const prompt = ports.models.calls[0]?.messages[0]?.content ?? "";
    expect(prompt).toContain(
      `- ${unescaped.title} (correctness, blocking) at ${unreviewedPath}:9-9: dismissed as not a problem`,
    );
    const raised = (await reviewThreads(db)).filter(
      (thread) => thread.anchorRevisionId === unreviewed.revisionId,
    );
    expect(raised.map((thread) => thread.finding?.title)).toEqual([unbounded.title]);
  });

  it("skips a revision that is no longer the change's head", async () => {
    const { deps, ports } = await demoReview();
    const outcome = await runReviewStage(deps, {
      changeId: demoChanges.review.id,
      revisionId: "rev_demo12a",
      stageRunId: "stg_demo12a_review",
      attempt: 2,
    });
    // rev_demo12a has the demo's own findings, so it counts as reviewed.
    expect(outcome).toEqual({ status: "succeeded" });
    expect(ports.models.calls).toHaveLength(0);

    await deps.db
      .update(schema.changes)
      .set({ headRevisionId: "rev_later" })
      .where(eq(schema.changes.id, changeId));
    expect(await runReviewStage(deps, unreviewed)).toMatchObject({ status: "skipped" });
    expect(ports.models.calls).toHaveLength(0);
  });
});

describe("dismissalTally", () => {
  it("counts settled findings by category, and the ones dismissed as not a problem", async () => {
    const { deps, db } = await demoReview();
    // The demo: one correctness finding resolved, one design finding dismissed as a decision.
    expect(await dismissalTally(deps, atlas.id)).toEqual({
      correctness: { raised: 1, notAProblem: 0 },
      design: { raised: 1, notAProblem: 0 },
    });

    const dismissed = { status: "dismissed", dismissal: "not_a_problem" } as const;
    await addThread(db, [], dismissed);
    await addThread(db, [], dismissed);
    await addThread(db, [], { status: "resolved" });
    await addThread(db, [], { status: "open" });
    await addThread(db, [], { ...dismissed, origin: "human", finding: null });

    expect(await dismissalTally(deps, atlas.id)).toEqual({
      correctness: { raised: 1, notAProblem: 0 },
      design: { raised: 4, notAProblem: 2 },
    });
    expect(await dismissalTally(deps, "rep_billing")).toEqual({});
  });

  it("reaches the review prompt, and holds back minor findings of a category people keep dismissing", async () => {
    const { deps, db, ports } = await demoReview();
    const dismissed = { status: "dismissed", dismissal: "not_a_problem", settledBy: jonas.id };
    for (let i = 0; i < 3; i++) await addThread(db, [], dismissed as never);
    const design = { ...unbounded, category: "design" } as const;
    ports.models.reply("review", {
      output: {
        findings: [
          { ...design, severity: "minor", title: "A second way to build CSV" },
          { ...design, severity: "important", title: "The export bypasses the audit service" },
          { ...unescaped, severity: "minor" },
        ],
        followed: [],
      },
    });

    await runReviewStage(deps, unreviewed);

    const prompt = ports.models.calls[0]?.messages[0]?.content ?? "";
    expect(prompt).toContain(
      "design: raised and settled 4, dismissed as not a problem 3 (held back)",
    );
    expect(prompt).toContain("correctness: raised and settled 1, dismissed as not a problem 0\n");
    expect((await reviewThreads(db)).map((thread) => thread.finding?.title)).toEqual(
      expect.arrayContaining(["The export bypasses the audit service", unescaped.title]),
    );
    expect(
      (await changeThreads(db, changeId)).some(
        (thread) => thread.finding?.title === "A second way to build CSV",
      ),
    ).toBe(false);
  });
});
