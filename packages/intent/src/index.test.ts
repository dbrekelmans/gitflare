import type { StageInput } from "@gitflare/core";
import { defaultOrganisationSettings, forkRepoName } from "@gitflare/core";
import { type Db, schema } from "@gitflare/db";
import { createTestDb } from "@gitflare/db/testing";
import { createFakePorts, type FakePorts, fakeAuthor } from "@gitflare/testing";
import { beforeEach, describe, expect, it } from "vitest";
import { currentIntent, runIntentStage } from "./index";

const orgId = "org_1";
const repoId = "rep_1";
const slug = "atlas";
const authorId = "usr_1";

let db: Db;
let ports: FakePorts;

beforeEach(async () => {
  db = createTestDb();
  ports = createFakePorts();

  await db.insert(schema.organisations).values({
    id: orgId,
    name: "Test Org",
    slug: "test",
    settings: defaultOrganisationSettings,
    createdAt: 0,
  });
  await db.insert(schema.repositories).values({
    id: repoId,
    organisationId: orgId,
    slug,
    createdAt: 0,
  });
});

function deps() {
  return {
    db,
    capture: ports.capture,
    diffs: ports.diffs,
    models: ports.models,
    live: ports.live,
    clock: ports.clock,
    ids: ports.ids,
  };
}

/** Commits one revision's files to the fork and inserts the change/revision rows. */
async function seedChange(input: {
  changeId: string;
  sessionId: string;
  title: string;
  file: { path: string; content: string };
}) {
  const changeId = input.changeId as never;
  const sessionId = input.sessionId as never;
  const repo = forkRepoName(slug, sessionId);
  await ports.git.createRepo(repo);
  const base = await ports.git.commitFiles({
    repo,
    branch: "main",
    expectedParent: null,
    changes: [{ path: "README.md", content: "readme" }],
    message: "base",
    author: fakeAuthor,
  });
  const head = await ports.git.commitFiles({
    repo,
    branch: "main",
    expectedParent: base.sha,
    changes: [{ path: input.file.path, content: input.file.content }],
    message: "head",
    author: fakeAuthor,
  });
  const revisionId = `rev_${input.changeId}_1`;
  await db.insert(schema.changes).values({
    id: changeId,
    repositoryId: repoId as never,
    sessionId,
    number: 1,
    title: input.title,
    status: "open",
    authorId: authorId as never,
    headRef: "main",
    baseSha: base.sha,
    headSha: head.sha,
    headRevisionId: revisionId as never,
    openedAt: 0,
  });
  await db.insert(schema.revisions).values({
    id: revisionId as never,
    changeId,
    number: 1,
    baseSha: base.sha,
    headSha: head.sha,
    pushedAt: 0,
    commits: 1,
    filesChanged: 1,
    insertions: 1,
    deletions: 0,
  });
  return { revisionId, baseSha: base.sha, headSha: head.sha, repo };
}

/** Adds a second revision to an existing change, on top of its current head. */
async function seedSecondRevision(input: {
  changeId: string;
  repo: string;
  baseSha: string;
  file: { path: string; content: string };
}) {
  const head = await ports.git.commitFiles({
    repo: input.repo,
    branch: "main",
    expectedParent: input.baseSha,
    changes: [{ path: input.file.path, content: input.file.content }],
    message: "revision 2",
    author: fakeAuthor,
  });
  const revisionId = `rev_${input.changeId}_2`;
  await db.insert(schema.revisions).values({
    id: revisionId as never,
    changeId: input.changeId as never,
    number: 2,
    baseSha: input.baseSha,
    headSha: head.sha,
    pushedAt: 0,
    commits: 1,
    filesChanged: 1,
    insertions: 1,
    deletions: 0,
  });
  return { revisionId, headSha: head.sha };
}

function stageInput(changeId: string, revisionId: string, attempt = 1): StageInput {
  return {
    changeId: changeId as never,
    revisionId: revisionId as never,
    stageRunId: "stg_1" as never,
    attempt,
  };
}

describe("runIntentStage", () => {
  it("grades a change with a capture as transcript", async () => {
    const { revisionId } = await seedChange({
      changeId: "chg_1",
      sessionId: "ses_1",
      title: "Add audit export",
      file: { path: "src/audit.ts", content: "export function audit() {}" },
    });
    ports.capture.set({
      changeId: "chg_1" as never,
      sessions: [
        {
          changeId: "chg_1" as never,
          agentSessionId: "agent-session-1",
          agent: "claude",
          model: null,
          checkpointIds: ["cp_1"],
          turns: [{ kind: "prompt", text: "Add a CSV export of the audit log.", at: null }],
          attribution: null,
        },
      ],
      missingCheckpointIds: [],
    });
    ports.models.reply("intent", {
      output: { statement: "Let a workspace owner export its audit log as CSV." },
    });

    const outcome = await runIntentStage(deps(), stageInput("chg_1", revisionId));
    expect(outcome).toEqual({ status: "succeeded" });

    const intent = await currentIntent(deps(), "chg_1" as never);
    expect(intent?.grade).toBe("transcript");
    expect(intent?.version).toBe(1);
    expect(intent?.checkpointIds).toEqual(["cp_1"]);
    expect(intent?.statement).toBe("Let a workspace owner export its audit log as CSV.");
    expect(ports.live.types("chg_1" as never)).toEqual(["intent.updated"]);

    const prompt = ports.models.calls[0]?.messages[0]?.content ?? "";
    expect(prompt).toContain("Add a CSV export of the audit log.");
    expect(prompt).toContain("src/audit.ts");
  });

  it("grades a change with no capture as diff", async () => {
    const { revisionId } = await seedChange({
      changeId: "chg_2",
      sessionId: "ses_2",
      title: "Fix invite rate limit",
      file: { path: "src/invites.ts", content: "export function invite() {}" },
    });
    ports.models.reply("intent", { output: { statement: "Cap invites per workspace." } });

    await runIntentStage(deps(), stageInput("chg_2", revisionId));

    const intent = await currentIntent(deps(), "chg_2" as never);
    expect(intent?.grade).toBe("diff");
    expect(intent?.checkpointIds).toEqual([]);

    const prompt = ports.models.calls[0]?.messages[0]?.content ?? "";
    expect(prompt).toContain("No agent session transcript is available");
    expect(prompt).toContain("src/invites.ts");
  });

  it("skips a later revision with a reason", async () => {
    const { revisionId, repo, headSha } = await seedChange({
      changeId: "chg_3",
      sessionId: "ses_3",
      title: "Something",
      file: { path: "src/a.ts", content: "a" },
    });
    ports.models.reply("intent", { output: { statement: "First statement." } });
    await runIntentStage(deps(), stageInput("chg_3", revisionId));
    expect(ports.models.calls).toHaveLength(1);

    const { revisionId: revision2Id } = await seedSecondRevision({
      changeId: "chg_3",
      repo,
      baseSha: headSha,
      file: { path: "src/b.ts", content: "b" },
    });

    const outcome = await runIntentStage(deps(), stageInput("chg_3", revision2Id));
    expect(outcome).toEqual({
      status: "skipped",
      reason: "Intent is derived once, when the change opens.",
    });
    expect(ports.models.calls).toHaveLength(1); // no second call
    expect((await currentIntent(deps(), "chg_3" as never))?.version).toBe(1);

    // A requested re-run, on that same later revision, is not skipped: it is
    // told apart from the revision's automatic first attempt by `attempt`,
    // not by comparing `revisionId` to the existing intent's.
    ports.models.reply("intent", { output: { statement: "Re-derived statement." } });
    const rerun = await runIntentStage(deps(), stageInput("chg_3", revision2Id, 2));
    expect(rerun).toEqual({ status: "succeeded" });
    const reDerived = await currentIntent(deps(), "chg_3" as never);
    expect(reDerived?.version).toBe(2);
    expect(reDerived?.revisionId).toBe(revision2Id);
    expect(reDerived?.statement).toBe("Re-derived statement.");
  });

  it("adds a version on a re-run", async () => {
    const { revisionId } = await seedChange({
      changeId: "chg_4",
      sessionId: "ses_4",
      title: "Something",
      file: { path: "src/a.ts", content: "a" },
    });
    ports.models.reply("intent", { output: { statement: "First statement." } });
    ports.models.reply("intent", { output: { statement: "Second statement." } });

    await runIntentStage(deps(), stageInput("chg_4", revisionId));
    const outcome = await runIntentStage(deps(), stageInput("chg_4", revisionId, 2));

    expect(outcome).toEqual({ status: "succeeded" });
    const intent = await currentIntent(deps(), "chg_4" as never);
    expect(intent?.version).toBe(2);
    expect(intent?.statement).toBe("Second statement.");
  });

  it("is idempotent when the same attempt is retried", async () => {
    const { revisionId } = await seedChange({
      changeId: "chg_4b",
      sessionId: "ses_4b",
      title: "Something",
      file: { path: "src/a.ts", content: "a" },
    });
    ports.models.reply("intent", { output: { statement: "Only statement." } });

    const first = await runIntentStage(deps(), stageInput("chg_4b", revisionId));
    const retried = await runIntentStage(deps(), stageInput("chg_4b", revisionId));

    expect(first).toEqual({ status: "succeeded" });
    expect(retried).toEqual({ status: "succeeded" });
    expect(ports.models.calls).toHaveLength(1); // the retry never calls the model again
    const intent = await currentIntent(deps(), "chg_4b" as never);
    expect(intent?.version).toBe(1);
  });

  it("fails the stage on a malformed model reply", async () => {
    const { revisionId } = await seedChange({
      changeId: "chg_5",
      sessionId: "ses_5",
      title: "Something",
      file: { path: "src/a.ts", content: "a" },
    });
    ports.models.reply("intent", { output: { statement: "" } });

    await expect(runIntentStage(deps(), stageInput("chg_5", revisionId))).rejects.toThrow();
    expect(await currentIntent(deps(), "chg_5" as never)).toBeNull();
  });
});

describe("currentIntent", () => {
  it("is null for a change with no intent", async () => {
    expect(await currentIntent(deps(), "chg_none" as never)).toBeNull();
  });
});
