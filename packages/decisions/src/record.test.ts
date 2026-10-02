import {
  applyDecisionEvent,
  type Decision,
  type DecisionId,
  ForgeError,
  initialDecisionState,
} from "@gitflare/core";
import { ModelError } from "@gitflare/core/ports";
import { schema } from "@gitflare/db";
import { demo, demoChanges, demoUsers } from "@gitflare/testing/demo";
import { and, asc, eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { parseDecisionFile } from "./file";
import { decisionHistory, revertDecision } from "./read";
import { linkDecision, recordDecision, recordDecisionEvent, settleChangeDecisions } from "./record";
import { reindexDecisions } from "./reindex";
import { retrieveDecisions } from "./retrieve";
import type { DecisionsDeps } from "./store";
import { atlas, demoRecord } from "./testing/setup";

const person = { userId: demoUsers.maya.id, changeId: null, threadId: null, note: null };

const noEval = {
  repositoryId: atlas.id,
  title: "No eval, anywhere",
  statement: "Never call eval or new Function, in application code or in build scripts.",
  rationale: "A templating shortcut once ran a customer's string.",
  globs: [],
  origin: "manual" as const,
  changeId: null,
  threadId: null,
  userId: demoUsers.maya.id,
};

async function row(deps: DecisionsDeps, id: DecisionId) {
  const [found] = await deps.db.select().from(schema.decisions).where(eq(schema.decisions.id, id));
  if (!found) throw new Error(`no decision ${id}`);
  return found;
}

/** The decision's events, oldest first. */
async function events(deps: DecisionsDeps, id: DecisionId) {
  return (await decisionHistory(deps, id)).events.reverse();
}

describe("recordDecision", () => {
  it("writes the file, indexes and embeds the decision, and records `created`", async () => {
    const { deps, file } = await demoRecord();
    const decision = await recordDecision(deps, noEval);

    expect(decision).toMatchObject({
      path: "decisions/no-eval-anywhere.md",
      status: "active",
      strength: 0.5,
      scope: { kind: "general" },
      origin: "manual",
    });
    const text = await file(decision.path);
    expect(parseDecisionFile(decision.path, text ?? "")).toEqual({
      ...decision,
      repositoryId: undefined,
    });

    const stored = await row(deps, decision.id);
    expect(stored.embedding).toHaveLength(32);
    expect(stored.embeddingModel).toBe(atlasModels().embedding);
    expect(stored.fileSha).toMatch(/^[0-9a-f]{40}$/);
    expect(await events(deps, decision.id)).toMatchObject([
      { kind: "created", userId: demoUsers.maya.id, strengthBefore: 0.5, strengthAfter: 0.5 },
    ]);
  });

  it("gives a second decision with the same title its own file", async () => {
    const { deps } = await demoRecord();
    const first = await recordDecision(deps, noEval);
    const second = await recordDecision(deps, { ...noEval, statement: "A different rule." });
    expect(second.id).not.toBe(first.id);
    expect(second.path).toBe("decisions/no-eval-anywhere-2.md");
  });

  it("records the same words from the same thread once", async () => {
    const { deps, db } = await demoRecord();
    const fromThread = {
      ...noEval,
      origin: "dismissed_finding" as const,
      threadId: "thr_x" as const,
    };
    const first = await recordDecision(deps, fromThread);
    const again = await recordDecision(deps, fromThread);
    expect(again).toEqual(first);
    const stored = await db
      .select()
      .from(schema.decisions)
      .where(eq(schema.decisions.originThreadId, "thr_x"));
    expect(stored).toHaveLength(1);
  });

  it("keeps a decision the model could not embed, and embeds it at the next retrieval", async () => {
    const { deps, ports } = await demoRecord();
    vi.spyOn(ports.models, "embed").mockRejectedValueOnce(
      new ModelError("budget_exceeded", "the month is spent"),
    );
    const decision = await recordDecision(deps, noEval);
    expect((await row(deps, decision.id)).embedding).toBeNull();

    const found = await retrieveDecisions(deps, {
      repositoryId: atlas.id,
      query: "calling eval in build scripts",
      limit: 1,
    });
    expect(found[0]?.decision.id).toBe(decision.id);
    expect((await row(deps, decision.id)).embedding).toHaveLength(32);
  });

  it("commits again when the context repo moved under it", async () => {
    const { deps, git, repos, file } = await demoRecord();
    const commit = git.commitFiles.bind(git);
    vi.spyOn(git, "commitFiles").mockImplementationOnce(async (request) => {
      git.push(repos.context, "main", { "decisions/README.md": "Someone else got here first." });
      return commit(request);
    });
    const decision = await recordDecision(deps, noEval);
    expect(await file(decision.path)).toContain("# No eval, anywhere");
    expect(await file("decisions/README.md")).toBe("Someone else got here first.");
  });
});

function atlasModels() {
  return demo.organisation.settings.models;
}

describe("strength", () => {
  it("is, after any history, exactly what replaying the events through the machine gives", async () => {
    const { deps, file } = await demoRecord();
    const decision = await recordDecision(deps, noEval);
    const { id } = decision;

    // Everything that touches a decision: the port's links settled at merge,
    // a person's edits, a conversation's confirmation, and a rebuild.
    await linkDecision(deps, {
      changeId: demoChanges.review.id,
      decisionId: id,
      relation: "cited",
    });
    await settleChangeDecisions(deps, demoChanges.review.id);
    await recordDecisionEvent(deps, id, { ...person, kind: "reshaped", statement: "Never eval." });
    await linkDecision(deps, {
      changeId: demoChanges.cloud.id,
      decisionId: id,
      relation: "contradicted",
    });
    await settleChangeDecisions(deps, demoChanges.cloud.id);
    await reindexDecisions(deps, atlas.id);
    await recordDecisionEvent(deps, id, { ...person, kind: "confirmed" });
    await linkDecision(deps, {
      changeId: demoChanges.merged.id,
      decisionId: id,
      relation: "followed",
    });
    await settleChangeDecisions(deps, demoChanges.merged.id);
    const reshaped = (await events(deps, id)).find((event) => event.kind === "reshaped");
    await revertDecision(deps, { decisionId: id, eventId: reshaped?.id ?? "dev_x", userId: null });

    const history = await events(deps, id);
    expect(history.map((event) => event.kind)).toEqual([
      "created",
      "cited",
      "reshaped",
      "contradiction_accepted",
      "confirmed",
      "followed",
      "reverted",
    ]);
    let state = initialDecisionState();
    for (const event of history) {
      if (event.kind !== "created") expect(event.strengthBefore).toBe(state.strength);
      state = applyDecisionEvent(state, event.kind);
      expect(event.strengthAfter).toBe(state.strength);
    }
    const stored = await row(deps, id);
    expect({ strength: stored.strength, status: stored.status }).toEqual(state);
    // 0.5 → cited 0.575 → contradicted 0.345 → confirmed 0.50875 → followed 0.557875
    expect(stored.strength).toBeCloseTo(0.557875, 10);
    expect(parseDecisionFile(stored.path, (await file(stored.path)) ?? "").strength).toBe(
      stored.strength,
    );
  });

  it("loses no event when several land on one decision at once", async () => {
    const { deps, file } = await demoRecord();
    const { id, path } = await recordDecision(deps, noEval);

    await Promise.all([
      recordDecisionEvent(deps, id, { ...person, kind: "confirmed" }),
      recordDecisionEvent(deps, id, { ...person, kind: "confirmed" }),
      recordDecisionEvent(deps, id, { ...person, kind: "cited" }),
    ]);

    const history = await events(deps, id);
    expect(history).toHaveLength(4);
    // Each event starts where another ended: none was computed from a stale read.
    const reached = new Set(history.map((event) => event.strengthAfter));
    for (const event of history.slice(1)) expect(reached.has(event.strengthBefore)).toBe(true);
    expect(new Set(history.slice(1).map((event) => event.strengthBefore)).size).toBe(3);
    // Reinforcements commute: 1 − 0.5 × 0.75 × 0.75 × 0.85.
    const stored = await row(deps, id);
    expect(stored.strength).toBeCloseTo(0.7609375, 10);
    expect(parseDecisionFile(path, (await file(path)) ?? "").strength).toBe(stored.strength);
  });

  it("refuses `created` as an event, and reviving a decision that is not dormant", async () => {
    const { deps } = await demoRecord();
    const { id } = await recordDecision(deps, noEval);
    await recordDecisionEvent(deps, id, { ...person, kind: "confirmed" });
    await expect(recordDecisionEvent(deps, id, { ...person, kind: "created" })).rejects.toThrow(
      ForgeError,
    );
    await expect(recordDecisionEvent(deps, id, { ...person, kind: "revived" })).rejects.toThrow(
      /dormant/,
    );
    expect((await row(deps, id)).strength).toBe(0.625);
  });
});

describe("a dormant decision", () => {
  it("is never retrieved, however close the query", async () => {
    const { deps } = await demoRecord();
    const moment = demo.decisions.find((d) => d.status === "dormant") as Decision;
    const found = await retrieveDecisions(deps, {
      repositoryId: atlas.id,
      query: `${moment.title}\n${moment.statement}`,
      limit: 50,
    });
    expect(found.map((entry) => entry.decision.id).sort()).toEqual(
      demo.decisions
        .filter((d) => d.status === "active")
        .map((d) => d.id)
        .sort(),
    );
  });

  it("goes dormant by accepted contradictions, and comes back when a person revives it", async () => {
    const { deps, file } = await demoRecord();
    const decision = await recordDecision(deps, noEval);
    const query = { repositoryId: atlas.id, query: noEval.statement, limit: 3 };
    const retrieved = async () =>
      (await retrieveDecisions(deps, query)).map((entry) => entry.decision.id);
    expect((await retrieved())[0]).toBe(decision.id);

    // Two changes went against it and were merged anyway: 0.5 → 0.3 → 0.18.
    for (const change of [demoChanges.review, demoChanges.cloud]) {
      await linkDecision(deps, {
        changeId: change.id,
        decisionId: decision.id,
        relation: "contradicted",
      });
      await settleChangeDecisions(deps, change.id);
    }
    expect(await row(deps, decision.id)).toMatchObject({ status: "dormant" });
    expect((await row(deps, decision.id)).strength).toBeCloseTo(0.18, 10);
    expect(await file(decision.path)).toContain("status: dormant");
    expect(await retrieved()).not.toContain(decision.id);

    const revived = await recordDecisionEvent(deps, decision.id, { ...person, kind: "revived" });
    expect(revived).toMatchObject({ status: "active", strength: 0.5 });
    expect(await file(decision.path)).toContain("status: active");
    expect((await retrieved())[0]).toBe(decision.id);
    expect((await events(deps, decision.id)).at(-1)).toMatchObject({
      kind: "revived",
      userId: demoUsers.maya.id,
      strengthAfter: 0.5,
    });
  });
});

describe("retrieveDecisions", () => {
  it("returns the nearest active decisions first, with their similarity", async () => {
    const { deps } = await demoRecord();
    const found = await retrieveDecisions(deps, {
      repositoryId: atlas.id,
      query: "a counter that is incremented and compared, kept in KV",
      limit: 2,
    });
    expect(found).toHaveLength(2);
    expect(found[0]?.decision.id).toBe("dec_counters_in_durable_objects");
    expect(found[0]?.similarity).toBeGreaterThan(found[1]?.similarity ?? 1);
    expect(found[0]?.similarity).toBeLessThanOrEqual(1);
  });

  it("embeds the query and the unembedded decisions in one call, once", async () => {
    const { deps, ports } = await demoRecord();
    const query = { repositoryId: atlas.id, query: "logging tokens", limit: 2 };
    await retrieveDecisions(deps, query);
    await retrieveDecisions(deps, query);
    expect(ports.models.embedCalls.map((call) => call.texts.length)).toEqual([5, 1]);
    expect(ports.models.embedCalls[0]).toMatchObject({
      model: atlasModels().embedding,
      attribution: { agent: "decisions", repositoryId: atlas.id },
    });
  });

  it("records what a change was given, without forgetting what the change did with it", async () => {
    const { deps, db } = await demoRecord();
    const changeId = demoChanges.review.id;
    await db
      .delete(schema.changeDecisions)
      .where(eq(schema.changeDecisions.decisionId, "dec_no_secrets_in_logs"));

    const found = await retrieveDecisions(deps, {
      repositoryId: atlas.id,
      query: "a counter that is incremented and compared, kept in KV, and tokens in a log line",
      limit: 4,
      changeId,
    });
    const links = await db
      .select()
      .from(schema.changeDecisions)
      .where(eq(schema.changeDecisions.changeId, changeId));
    const relation = Object.fromEntries(links.map((link) => [link.decisionId, link]));
    // The demo already had the change following one and citing another.
    expect(relation.dec_counters_in_durable_objects?.relation).toBe("followed");
    expect(relation.dec_fixed_windows?.relation).toBe("cited");
    expect(relation.dec_no_secrets_in_logs?.relation).toBe("retrieved");
    for (const entry of found) {
      expect(relation[entry.decision.id]?.similarity).toBe(entry.similarity);
    }
  });
});

describe("settleChangeDecisions", () => {
  it("reinforces what the change followed or cited and leaves what it was only given", async () => {
    const { deps, commits } = await demoRecord();
    const before = commits();
    await settleChangeDecisions(deps, demoChanges.review.id);

    // followed: +10% of the way to 1; cited: +15%.
    expect((await row(deps, "dec_thin_routes")).strength).toBeCloseTo(0.766, 10);
    expect((await row(deps, "dec_counters_in_durable_objects")).strength).toBeCloseTo(0.694, 10);
    expect((await row(deps, "dec_fixed_windows")).strength).toBeCloseTo(0.575, 10);
    expect((await row(deps, "dec_no_secrets_in_logs")).strength).toBe(0.83);
    expect((await events(deps, "dec_fixed_windows")).at(-1)).toMatchObject({
      kind: "cited",
      changeId: demoChanges.review.id,
      threadId: "thr_demo12window",
    });
    expect(
      (await events(deps, "dec_no_secrets_in_logs")).filter(
        (event) => event.changeId === demoChanges.review.id,
      ),
    ).toEqual([]);
    // One merge is one commit to the context repo.
    expect(commits()).toBe(before + 1);
  });

  it("settles a change once, however often it is called", async () => {
    const { deps, db, commits } = await demoRecord();
    await settleChangeDecisions(deps, demoChanges.review.id);
    const settled = await db.select().from(schema.decisionEvents);
    const after = commits();

    await settleChangeDecisions(deps, demoChanges.review.id);
    expect(await db.select().from(schema.decisionEvents)).toEqual(settled);
    expect((await row(deps, "dec_thin_routes")).strength).toBeCloseTo(0.766, 10);
    expect(commits()).toBe(after);
  });

  it("finishes a settlement that stopped before the files were written", async () => {
    const { deps, git, file } = await demoRecord();
    vi.spyOn(git, "commitFiles").mockRejectedValueOnce(
      new ForgeError("unavailable", "git is down"),
    );
    await expect(settleChangeDecisions(deps, demoChanges.review.id)).rejects.toThrow("git is down");
    expect(await file("decisions/thin-routes.md")).toContain("strength: 0.74");

    await settleChangeDecisions(deps, demoChanges.review.id);
    expect((await row(deps, "dec_thin_routes")).strength).toBeCloseTo(0.766, 10);
    expect(await file("decisions/thin-routes.md")).toContain("strength: 0.766");
  });

  it("weakens a decision the change contradicted and was merged against", async () => {
    const { deps, db } = await demoRecord();
    await linkDecision(deps, {
      changeId: demoChanges.review.id,
      decisionId: "dec_thin_routes",
      relation: "contradicted",
      threadId: "thr_demo12key",
    });
    const [link] = await db
      .select()
      .from(schema.changeDecisions)
      .where(
        and(
          eq(schema.changeDecisions.changeId, demoChanges.review.id),
          eq(schema.changeDecisions.decisionId, "dec_thin_routes"),
        ),
      );
    // The later word replaced `followed`; what retrieval measured is kept.
    expect(link).toMatchObject({ relation: "contradicted", similarity: 0.71 });

    await settleChangeDecisions(deps, demoChanges.review.id);
    expect((await row(deps, "dec_thin_routes")).strength).toBeCloseTo(0.444, 10);
    expect((await events(deps, "dec_thin_routes")).at(-1)).toMatchObject({
      kind: "contradiction_accepted",
      threadId: "thr_demo12key",
    });
  });
});

describe("rewording and reverting", () => {
  it("restores the earlier wording, in the index and the file, and records it", async () => {
    const { deps, file } = await demoRecord();
    const decision = await recordDecision(deps, noEval);
    const narrowed = "Never call eval in application code. Build scripts may.";

    const edited = await recordDecisionEvent(deps, decision.id, {
      ...person,
      kind: "reshaped",
      title: "No eval in application code",
      statement: narrowed,
    });
    expect(edited).toMatchObject({ statement: narrowed, strength: 0.5, path: decision.path });
    expect(await file(decision.path)).toContain(`# No eval in application code\n\n${narrowed}\n`);
    const [, reshaped] = await events(deps, decision.id);
    expect(reshaped).toMatchObject({
      kind: "reshaped",
      statementBefore: noEval.statement,
      statementAfter: narrowed,
      strengthBefore: 0.5,
      strengthAfter: 0.5,
    });

    const reverted = await revertDecision(deps, {
      decisionId: decision.id,
      eventId: reshaped?.id ?? "dev_x",
      userId: demoUsers.priya.id,
    });
    expect(reverted.statement).toBe(noEval.statement);
    expect(await file(decision.path)).toContain(`\n\n${noEval.statement}\n`);
    expect((await events(deps, decision.id)).at(-1)).toMatchObject({
      kind: "reverted",
      userId: demoUsers.priya.id,
      statementBefore: narrowed,
      statementAfter: noEval.statement,
      strengthAfter: 0.5,
    });
  });

  it("finds a reworded decision by its new words, and after a revert by its old ones", async () => {
    const { deps } = await demoRecord();
    const decision = await recordDecision(deps, noEval);
    const nearest = async (query: string) =>
      (await retrieveDecisions(deps, { repositoryId: atlas.id, query, limit: 1 }))[0]?.decision.id;
    const reworded = "Parse configuration with the schema library; reject unknown keys.";

    await recordDecisionEvent(deps, decision.id, {
      ...person,
      kind: "reshaped",
      title: "Strict configuration",
      statement: reworded,
    });
    expect(await nearest(reworded)).toBe(decision.id);
    expect(await nearest(noEval.statement)).not.toBe(decision.id);

    const [, reshaped] = await events(deps, decision.id);
    await revertDecision(deps, {
      decisionId: decision.id,
      eventId: reshaped?.id ?? "dev_x",
      userId: null,
    });
    await recordDecisionEvent(deps, decision.id, {
      ...person,
      kind: "reshaped",
      title: noEval.title,
    });
    expect(await nearest(noEval.statement)).toBe(decision.id);
  });

  it("can undo a rewording from the demo's own history", async () => {
    const { deps, db } = await demoRecord();
    const reverted = await revertDecision(deps, {
      decisionId: "dec_no_secrets_in_logs",
      eventId: "dev_ns4",
      userId: demoUsers.maya.id,
    });
    expect(reverted.statement).toBe("Never log access tokens.");
    expect(reverted.strength).toBe(0.83);
    const all = await db
      .select()
      .from(schema.decisionEvents)
      .where(eq(schema.decisionEvents.decisionId, "dec_no_secrets_in_logs"))
      .orderBy(asc(schema.decisionEvents.createdAt));
    expect(all.at(-1)).toMatchObject({
      kind: "reverted",
      statementAfter: "Never log access tokens.",
    });
  });

  it("refuses to revert an event that changed no wording, and records nothing for a no-op", async () => {
    const { deps } = await demoRecord();
    await expect(
      revertDecision(deps, { decisionId: "dec_thin_routes", eventId: "dev_tr2", userId: null }),
    ).rejects.toThrow(/did not change the wording/);
    await expect(
      revertDecision(deps, { decisionId: "dec_thin_routes", eventId: "dev_ns4", userId: null }),
    ).rejects.toThrow(/does not exist/);

    const before = await events(deps, "dec_thin_routes");
    const current = await row(deps, "dec_thin_routes");
    await recordDecisionEvent(deps, "dec_thin_routes", {
      ...person,
      kind: "reshaped",
      title: current.title,
      statement: `  ${current.statement}  `,
      rationale: current.rationale,
    });
    expect(await events(deps, "dec_thin_routes")).toEqual(before);
  });
});
