import { type Decision, type DecisionId, ForgeError } from "@gitflare/core";
import { schema, toDecision } from "@gitflare/db";
import { demo, demoChanges, demoUsers } from "@gitflare/testing/demo";
import { asc, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { EMBED_BATCH } from "./embedding";
import { renderDecisionFile } from "./file";
import { learnFromThread } from "./learn";
import { decisionHistory, revertDecision } from "./read";
import { recordDecision, recordDecisionEvent, settleChangeDecisions } from "./record";
import { reindexDecisions } from "./reindex";
import { retrieveDecisions } from "./retrieve";
import { addThread, atlas, demoRecord } from "./testing/setup";

// Retries, races and limits: what the first pass got wrong on its failure paths.

const { jonas, maya } = demoUsers;
const person = { userId: maya.id, changeId: null, threadId: null, note: null };
const embeddingModel = demo.organisation.settings.models.embedding;

type Record = Awaited<ReturnType<typeof demoRecord>>;

/** The decision's events, oldest first. */
async function events(record: Record, id: DecisionId) {
  return (await decisionHistory(record.deps, id)).events.reverse();
}

async function current(record: Record, id: DecisionId): Promise<Decision> {
  const [row] = await record.db.select().from(schema.decisions).where(eq(schema.decisions.id, id));
  if (!row) throw new Error(`no decision ${id}`);
  return toDecision(row);
}

/** `count` decisions as files on the context repo, none of them in the index. */
function manyDecisions(count: number): Decision[] {
  const [template] = demo.decisions;
  if (!template) throw new Error("the demo has no decision");
  return Array.from({ length: count }, (_, index) => ({
    ...template,
    id: `dec_many${String(index).padStart(3, "0")}` as DecisionId,
    path: `decisions/many-${index}.md`,
    title: `Rule number ${index}`,
    statement: `Rule ${index} says something only rule ${index} says.`,
  }));
}

describe("revertDecision", () => {
  it("restores the whole wording of a title-only edit, and refuses a second revert as a conflict", async () => {
    const record = await demoRecord();
    const before = await current(record, "dec_thin_routes");
    await recordDecisionEvent(record.deps, "dec_thin_routes", {
      ...person,
      kind: "reshaped",
      title: "Routes stay thin",
    });
    const edit = (await events(record, "dec_thin_routes")).at(-1);
    expect(edit).toMatchObject({ kind: "reshaped" });

    const reverted = await revertDecision(record.deps, {
      decisionId: "dec_thin_routes",
      eventId: edit?.id ?? "dev_x",
      userId: maya.id,
    });
    expect(reverted).toMatchObject({ title: before.title, statement: before.statement });

    const recorded = await events(record, "dec_thin_routes");
    const failure = await revertDecision(record.deps, {
      decisionId: "dec_thin_routes",
      eventId: edit?.id ?? "dev_x",
      userId: maya.id,
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ForgeError);
    expect((failure as ForgeError).code).toBe("conflict");
    expect(await events(record, "dec_thin_routes")).toEqual(recorded);
  });
});

describe("a retried operation repairs the file", () => {
  it("writes the file of a revived decision when the revive is retried after a failed commit", async () => {
    const record = await demoRecord();
    const moment = await current(record, "dec_moment_for_dates");
    expect(moment.status).toBe("dormant");
    record.git.failNextCommit(new ForgeError("unavailable", "the context repo is unreachable"));
    await expect(
      recordDecisionEvent(record.deps, moment.id, { ...person, kind: "revived" }),
    ).rejects.toThrow(/unreachable/);
    expect(await record.file(moment.path)).toContain("status: dormant");

    const revived = await recordDecisionEvent(record.deps, moment.id, {
      ...person,
      kind: "revived",
    });
    expect(revived.status).toBe("active");
    expect(await record.file(moment.path)).toBe(renderDecisionFile(revived));
    expect((await events(record, moment.id)).filter((e) => e.kind === "revived")).toHaveLength(1);
  });

  it("still refuses to revive a decision that was never dormant", async () => {
    const record = await demoRecord();
    await expect(
      recordDecisionEvent(record.deps, "dec_thin_routes", { ...person, kind: "revived" }),
    ).rejects.toThrow(/Only a dormant decision/);
  });

  it("writes the file of a learned decision when learning is retried after a failed commit", async () => {
    const record = await demoRecord();
    const threadId = await addThread(record.db, [
      ["agent", "This fetch has no retry."],
      [jonas, "We never retry inside a request handler."],
    ]);
    record.ports.models.reply("decisions", {
      output: {
        outcome: "new",
        title: "No retries inside request handlers",
        statement: "A request handler never retries an upstream call.",
        rationale: "",
        note: "Jonas ruled out a retry.",
      },
    });
    record.git.failNextCommit(new ForgeError("unavailable", "the context repo is unreachable"));
    await expect(learnFromThread(record.deps, threadId)).rejects.toThrow(/unreachable/);

    // No second reply is scripted: asking the model again would fail.
    const learned = await learnFromThread(record.deps, threadId);
    expect(learned?.title).toBe("No retries inside request handlers");
    expect(await record.file(learned?.path ?? "")).toBe(renderDecisionFile(learned as Decision));
    expect(record.ports.models.calls).toHaveLength(1);
  });
});

describe("learnFromThread marks what it considered", () => {
  const thread: Parameters<typeof addThread>[1] = [
    ["agent", "This formats a date by hand."],
    [jonas, "Fine for now."],
  ];

  it("asks the model once about a thread that decided nothing", async () => {
    const record = await demoRecord();
    const threadId = await addThread(record.db, thread);
    record.ports.models.reply("decisions", { output: { outcome: "none" } });

    expect(await learnFromThread(record.deps, threadId)).toBeNull();
    expect(await learnFromThread(record.deps, threadId)).toBeNull();
    expect(record.ports.models.calls).toHaveLength(1);
    const [row] = await record.db
      .select()
      .from(schema.threads)
      .where(eq(schema.threads.id, threadId));
    expect(row?.learnedAt).toBe(demo.now);
  });

  it("considers a thread again once it has been written in since", async () => {
    const record = await demoRecord();
    const threadId = await addThread(record.db, thread);
    record.ports.models
      .reply("decisions", { output: { outcome: "none" } })
      .reply("decisions", { output: { outcome: "none" } });
    await learnFromThread(record.deps, threadId);
    await record.db
      .update(schema.threads)
      .set({ lastMessageAt: demo.now + 1 })
      .where(eq(schema.threads.id, threadId));

    await learnFromThread(record.deps, threadId);
    expect(record.ports.models.calls).toHaveLength(2);
  });

  it("marks a thread whose dismissal recorded its decision, without the model", async () => {
    const record = await demoRecord();
    await learnFromThread(record.deps, "thr_demo12window");
    const [row] = await record.db
      .select()
      .from(schema.threads)
      .where(eq(schema.threads.id, "thr_demo12window"));
    expect(row?.learnedAt).toBe(demo.now);
    expect(record.ports.models.calls).toEqual([]);
  });
});

describe("retrieveDecisions with paths", () => {
  it("returns a decision tied to paths only for a change that touches them", async () => {
    const record = await demoRecord();
    const billing = await recordDecision(record.deps, {
      repositoryId: atlas.id,
      title: "Billing amounts are integers",
      statement: "Billing code keeps amounts as integer cents, never floats.",
      rationale: "",
      globs: ["src/billing/"],
      origin: "manual",
      changeId: null,
      threadId: null,
      userId: maya.id,
    });
    const found = async (paths?: string[]) =>
      (
        await retrieveDecisions(record.deps, {
          repositoryId: atlas.id,
          query: billing.statement,
          limit: 20,
          ...(paths && { paths }),
        })
      ).map((entry) => entry.decision.id);

    expect(await found()).toContain(billing.id);
    expect(await found(["src/billing/invoice.ts"])).toContain(billing.id);
    const elsewhere = await found(["src/invites/rate-limit.ts"]);
    expect(elsewhere).not.toContain(billing.id);
    // General rules still apply anywhere.
    expect(elsewhere).toContain("dec_thin_routes");
  });
});

describe("D1's limits", () => {
  it("rebuilds an index of more than a hundred decisions, embedding them in batches", async () => {
    const record = await demoRecord({ d1Limits: true });
    const many = manyDecisions(130);
    record.git.push(
      record.repos.context,
      "main",
      Object.fromEntries(many.map((d) => [d.path, renderDecisionFile(d)])),
    );

    const total = demo.decisions.length + many.length;
    expect(await reindexDecisions(record.deps, atlas.id)).toBe(total);
    expect(await record.db.select().from(schema.decisions)).toHaveLength(total);
    const sizes = record.ports.models.embedCalls.map((call) => call.texts.length);
    expect(sizes.reduce((sum, size) => sum + size, 0)).toBeGreaterThanOrEqual(many.length);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(EMBED_BATCH);
  });

  it("settles a change linked to more than a hundred decisions", async () => {
    const record = await demoRecord({ d1Limits: true });
    const many = manyDecisions(110);
    for (const decision of many) {
      await record.db
        .insert(schema.decisions)
        .values({ ...decision, repositoryId: atlas.id, fileSha: null });
      await record.db.insert(schema.changeDecisions).values({
        changeId: demoChanges.review.id,
        decisionId: decision.id,
        relation: "followed",
        similarity: 0.5,
      });
    }

    await settleChangeDecisions(record.deps, demoChanges.review.id);
    const followed = await record.db
      .select()
      .from(schema.decisionEvents)
      .where(eq(schema.decisionEvents.kind, "followed"));
    expect(followed.filter((e) => e.decisionId.startsWith("dec_many"))).toHaveLength(110);
    expect(await record.file(many[109]?.path ?? "")).toContain("Rule number 109");
  });
});

describe("reindexDecisions without the embedding model", () => {
  it("indexes every file with no vector, for retrieval to embed later", async () => {
    const record = await demoRecord();
    await record.db.delete(schema.decisions);
    record.ports.models.fail(embeddingModel, "unavailable");

    expect(await reindexDecisions(record.deps, atlas.id)).toBe(demo.decisions.length);
    const rows = await record.db.select().from(schema.decisions).orderBy(asc(schema.decisions.id));
    expect(rows).toHaveLength(demo.decisions.length);
    for (const row of rows) expect(row).toMatchObject({ embedding: null, embeddingModel: null });
  });

  it("drops a vector that no longer matches its words rather than keep it", async () => {
    const record = await demoRecord();
    const thin = await current(record, "dec_thin_routes");
    record.git.push(record.repos.context, "main", {
      [thin.path]: renderDecisionFile({ ...thin, statement: "Routes only parse and delegate." }),
    });
    record.ports.models.fail(embeddingModel, "unavailable");

    await reindexDecisions(record.deps, atlas.id);
    const [row] = await record.db
      .select()
      .from(schema.decisions)
      .where(eq(schema.decisions.id, thin.id));
    expect(row).toMatchObject({ statement: "Routes only parse and delegate.", embedding: null });
  });
});

describe("recordDecision under a race", () => {
  it("files two decisions with the same title, recorded at once, under two paths", async () => {
    const record = await demoRecord();
    const input = (statement: string) => ({
      repositoryId: atlas.id,
      title: "Errors carry a code",
      statement,
      rationale: "",
      globs: [],
      origin: "manual" as const,
      changeId: null,
      threadId: null,
      userId: maya.id,
    });

    const [a, b] = await Promise.all([
      recordDecision(record.deps, input("Every thrown error carries a code.")),
      recordDecision(record.deps, input("API errors carry a stable code.")),
    ]);
    expect(a.path).not.toBe(b.path);
    expect(await record.file(a.path)).toContain("Every thrown error carries a code.");
    expect(await record.file(b.path)).toContain("API errors carry a stable code.");
  });
});
