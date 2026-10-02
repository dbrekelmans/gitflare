import type { ChangeId, RepositoryId, RevisionId } from "@gitflare/core";
import { type Db, schema } from "@gitflare/db";
import { createTestDb } from "@gitflare/db/testing";
import { FakeGit } from "@gitflare/testing";
import { buildDemoGit, DEMO_CHECKPOINT_ID, demo, demoChanges } from "@gitflare/testing/demo";
import { seedDemo } from "@gitflare/testing/seed";
import { describe, expect, test } from "vitest";
import { captureChange, captureSettingsFiles } from "./index";

const clock = { now: () => 1_700_000_000_000 };

function compactLine(
  type: "user" | "assistant",
  text: string,
  ts = "2026-01-01T00:00:00.000Z",
): string {
  return JSON.stringify(
    type === "user"
      ? { v: 1, agent: "claude-code", type, ts, content: [{ text }] }
      : { v: 1, agent: "claude-code", type, ts, content: [{ type: "text", text }] },
  );
}

/** A checkpoint tree with one session, holding `lines` as its full-so-far compact transcript. */
function checkpointFiles(
  checkpointId: string,
  sessionId: string,
  lines: string[],
  sliceFrom: number,
): Record<string, string> {
  return {
    "metadata.json": JSON.stringify({
      checkpoint_id: checkpointId,
      sessions: [
        {
          metadata: "/0/metadata.json",
          compact_transcript: "/0/transcript.jsonl",
          prompt: "/0/prompt.txt",
        },
      ],
    }),
    "0/metadata.json": JSON.stringify({
      checkpoint_id: checkpointId,
      session_id: sessionId,
      agent: "Claude Code",
      model: "claude-sonnet-5",
      compact_transcript_start: sliceFrom,
      initial_attribution: {
        agent_lines: 10,
        agent_removed: 0,
        human_added: 1,
        human_modified: 0,
        human_removed: 0,
        agent_percentage: 90,
      },
    }),
    "0/transcript.jsonl": `${lines.join("\n")}\n`,
    "0/prompt.txt": "",
  };
}

async function seedChange(
  db: Db,
  repositoryId: RepositoryId,
  changeId: ChangeId,
  commits: { sha: string; checkpointIds: string[] }[],
): Promise<void> {
  await db.insert(schema.repositories).values({
    id: repositoryId,
    organisationId: "org_test",
    slug: "proj",
    description: "",
    defaultBranch: "main",
    headSha: null,
    captureEnabled: true,
    nextChangeNumber: 1,
    createdAt: 0,
    readyAt: 0,
    archivedAt: null,
  });
  await db.insert(schema.changes).values({
    id: changeId,
    repositoryId,
    sessionId: "ses_test",
    number: 1,
    title: "Test change",
    status: "processing",
    authorId: "usr_test",
    headRef: "refs/heads/work",
    baseSha: "0".repeat(40),
    headSha: "1".repeat(40),
    headRevisionId: "rev_test1" as RevisionId,
    openedAt: 0,
    lastEventSeq: 0,
  });
  await db.insert(schema.changeCommits).values(
    commits.map((commit, position) => ({
      changeId,
      sha: commit.sha,
      revisionId: "rev_test1" as RevisionId,
      position,
      message: "work",
      authorName: "A",
      authorEmail: "a@example.com",
      authoredAt: 0,
      checkpointIds: commit.checkpointIds,
    })),
  );
}

describe("captureChange", () => {
  test("reads the demo's change under review", async () => {
    const db = createTestDb();
    await seedDemo(db);
    const { git } = buildDemoGit();

    const capture = await captureChange({ db, git, clock }, demoChanges.review.id);

    expect(capture.missingCheckpointIds).toEqual([]);
    expect(capture.sessions).toHaveLength(1);
    const [session] = capture.sessions;
    expect(session?.agentSessionId).toBe(demo.capturedSessions[0]?.agentSessionId);
    expect(session?.checkpointIds).toEqual([DEMO_CHECKPOINT_ID]);
    expect(
      session?.turns.filter((turn) => turn.kind === "prompt").map((turn) => turn.text),
    ).toEqual([
      "Support had three workspaces send thousands of invites last week. Cap invites at 20 an hour per workspace and tell the client when it can retry.",
      "Keep the counter out of KV, we got bitten by its consistency before.",
    ]);
  });

  test("a change with no trailers yields an empty capture", async () => {
    const db = createTestDb();
    const repositoryId = "rep_notrailers" as RepositoryId;
    const changeId = "chg_notrailers" as ChangeId;
    await seedChange(db, repositoryId, changeId, [{ sha: "a".repeat(40), checkpointIds: [] }]);

    const capture = await captureChange({ db, git: new FakeGit(clock), clock }, changeId);

    expect(capture).toEqual({ changeId, sessions: [], missingCheckpointIds: [] });
  });

  test("a second checkpoint of the same session contributes only its own slice", async () => {
    const db = createTestDb();
    const git = new FakeGit(clock);
    const repositoryId = "rep_two" as RepositoryId;
    const changeId = "chg_two" as ChangeId;
    const context = "proj.context";
    git.createRepo(context);

    const firstLine = compactLine("user", "first prompt");
    const firstReply = compactLine("assistant", "first reply");
    const secondLine = compactLine("user", "second prompt");
    const secondReply = compactLine("assistant", "second reply");

    const ckpt1 = git.push(
      context,
      "ckpt1",
      checkpointFiles("ck1", "sess-A", [firstLine, firstReply], 0),
      {
        message: "Checkpoint: ck1",
      },
    );
    const ckpt2 = git.push(
      context,
      "ckpt2",
      checkpointFiles("ck2", "sess-A", [firstLine, firstReply, secondLine, secondReply], 2),
      { message: "Checkpoint: ck2" },
    );

    await seedChange(db, repositoryId, changeId, [
      { sha: "a".repeat(40), checkpointIds: ["ck1"] },
      { sha: "b".repeat(40), checkpointIds: ["ck2"] },
    ]);
    await db.insert(schema.checkpoints).values([
      {
        repositoryId,
        checkpointId: "ck1",
        ref: "ckpt1",
        tipSha: ckpt1.after,
        firstSeenAt: 0,
        updatedAt: 0,
      },
      {
        repositoryId,
        checkpointId: "ck2",
        ref: "ckpt2",
        tipSha: ckpt2.after,
        firstSeenAt: 0,
        updatedAt: 0,
      },
    ]);

    const capture = await captureChange({ db, git, clock }, changeId);

    expect(capture.missingCheckpointIds).toEqual([]);
    expect(capture.sessions).toHaveLength(1);
    const [session] = capture.sessions;
    expect(session?.checkpointIds).toEqual(["ck1", "ck2"]);
    expect(
      session?.turns.filter((turn) => turn.kind === "prompt").map((turn) => turn.text),
    ).toEqual(["first prompt", "second prompt"]);
  });

  test("a named checkpoint that never arrived is reported missing, without failing the rest", async () => {
    const db = createTestDb();
    const git = new FakeGit(clock);
    const repositoryId = "rep_missing" as RepositoryId;
    const changeId = "chg_missing" as ChangeId;
    const context = "proj.context";
    git.createRepo(context);

    const line = compactLine("user", "only prompt");
    const ckpt1 = git.push(context, "ckpt1", checkpointFiles("ck1", "sess-A", [line], 0), {
      message: "Checkpoint: ck1",
    });

    await seedChange(db, repositoryId, changeId, [
      { sha: "a".repeat(40), checkpointIds: ["ck1"] },
      { sha: "b".repeat(40), checkpointIds: ["ck-never-arrived"] },
    ]);
    await db.insert(schema.checkpoints).values([
      {
        repositoryId,
        checkpointId: "ck1",
        ref: "ckpt1",
        tipSha: ckpt1.after,
        firstSeenAt: 0,
        updatedAt: 0,
      },
    ]);

    const capture = await captureChange({ db, git, clock }, changeId);

    expect(capture.missingCheckpointIds).toEqual(["ck-never-arrived"]);
    expect(capture.sessions).toHaveLength(1);
  });
});

describe("captureSettingsFiles", () => {
  test("matches Entire's documented schema", () => {
    const files = captureSettingsFiles({ contextRepoPath: "git/northwind/atlas-web.context" });

    const settings = JSON.parse(files[".entire/settings.json"] ?? "{}");
    expect(settings.enabled).toBe(true);
    expect(settings.checkpoints.primary.type).toBe("git-refs");
    expect(settings.commit_linking).toBe("always");
    expect(settings.strategy_options.checkpoint_remote).toEqual({
      provider: "artifacts",
      repo: "git/northwind/atlas-web.context",
    });

    expect(files[".entire/.gitignore"]).toContain("settings.local.json");

    const hooks = JSON.parse(files[".claude/settings.json"] ?? "{}");
    expect(Object.keys(hooks.hooks)).toEqual(["PostToolUse", "SessionStart", "Stop"]);
  });
});
