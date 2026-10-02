import type { ChangeCapture, ChangeId, Push, RepositoryId, RevisionId } from "@gitflare/core";
import { type Db, schema } from "@gitflare/db";
import { createTestDb } from "@gitflare/db/testing";
import { FakeGit } from "@gitflare/testing";
import { buildDemoGit, DEMO_CHECKPOINT_ID, demo, demoChanges } from "@gitflare/testing/demo";
import { seedDemo } from "@gitflare/testing/seed";
import { describe, expect, test } from "vitest";
import {
  captureChange,
  captureSettingsFiles,
  condense,
  createCapture,
  missingCheckpoints,
  recordCheckpointPush,
} from "./index";

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

const defaultRawAttribution = {
  agent_lines: 10,
  agent_removed: 0,
  human_added: 1,
  human_modified: 0,
  human_removed: 0,
  agent_percentage: 90,
};

/** A checkpoint tree with one session, holding `lines` as its full-so-far compact transcript. */
function checkpointFiles(
  checkpointId: string,
  sessionId: string,
  lines: string[],
  sliceFrom: number,
  rawAttribution: typeof defaultRawAttribution = defaultRawAttribution,
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
      initial_attribution: rawAttribution,
    }),
    "0/transcript.jsonl": `${lines.join("\n")}\n`,
    "0/prompt.txt": "",
  };
}

/** A checkpoint that names `transcript.jsonl` but never writes it: compaction can fail. */
function checkpointFilesWithoutCompactTranscript(
  checkpointId: string,
  sessionId: string,
  fullLines: string[],
  sliceFrom: number,
): Record<string, string> {
  return {
    "metadata.json": JSON.stringify({
      checkpoint_id: checkpointId,
      sessions: [
        {
          metadata: "/0/metadata.json",
          transcript: "/0/full.jsonl",
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
      checkpoint_transcript_start: sliceFrom,
    }),
    "0/full.jsonl": `${fullLines.join("\n")}\n`,
    "0/prompt.txt": "",
  };
}

function fullLine(
  type: "user" | "assistant",
  text: string,
  ts = "2026-02-01T00:00:00.000Z",
): string {
  return JSON.stringify({
    type,
    timestamp: ts,
    message: { role: type === "user" ? "user" : "assistant", content: [{ type: "text", text }] },
  });
}

/** A native (Claude Code) transcript split across `full.jsonl` and `full.jsonl.001`, as chunking does. */
function chunkedFullTranscriptCheckpoint(
  checkpointId: string,
  sessionId: string,
  chunk0: string[],
  chunk1: string[],
  sliceFrom: number,
): Record<string, string> {
  return {
    "metadata.json": JSON.stringify({
      checkpoint_id: checkpointId,
      sessions: [
        { metadata: "/0/metadata.json", transcript: "/0/full.jsonl", prompt: "/0/prompt.txt" },
      ],
    }),
    "0/metadata.json": JSON.stringify({
      checkpoint_id: checkpointId,
      session_id: sessionId,
      agent: "Claude Code",
      model: "claude-sonnet-5",
      checkpoint_transcript_start: sliceFrom,
    }),
    "0/full.jsonl": `${chunk0.join("\n")}\n`,
    "0/full.jsonl.001": `${chunk1.join("\n")}\n`,
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

  test("a recorded checkpoint whose tip cannot be read is reported missing", async () => {
    const db = createTestDb();
    const git = new FakeGit(clock);
    const repositoryId = "rep_unreadable" as RepositoryId;
    const changeId = "chg_unreadable" as ChangeId;
    git.createRepo("proj.context");

    await seedChange(db, repositoryId, changeId, [
      { sha: "a".repeat(40), checkpointIds: ["ck-unreadable"] },
    ]);
    // Recorded, but the tip it names was never actually committed.
    await db.insert(schema.checkpoints).values([
      {
        repositoryId,
        checkpointId: "ck-unreadable",
        ref: "ckpt1",
        tipSha: "f".repeat(40),
        firstSeenAt: 0,
        updatedAt: 0,
      },
    ]);

    const capture = await captureChange({ db, git, clock }, changeId);

    expect(capture.missingCheckpointIds).toEqual(["ck-unreadable"]);
    expect(capture.sessions).toEqual([]);
  });

  test("falls back to full.jsonl when the compact transcript was never written", async () => {
    const db = createTestDb();
    const git = new FakeGit(clock);
    const repositoryId = "rep_fallback" as RepositoryId;
    const changeId = "chg_fallback" as ChangeId;
    const context = "proj.context";
    git.createRepo(context);

    const ckpt1 = git.push(
      context,
      "ckpt1",
      checkpointFilesWithoutCompactTranscript(
        "ck1",
        "sess-A",
        [fullLine("user", "native prompt"), fullLine("assistant", "native reply")],
        0,
      ),
      { message: "Checkpoint: ck1" },
    );

    await seedChange(db, repositoryId, changeId, [{ sha: "a".repeat(40), checkpointIds: ["ck1"] }]);
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

    expect(capture.sessions).toHaveLength(1);
    expect(
      capture.sessions[0]?.turns.filter((turn) => turn.kind === "prompt").map((turn) => turn.text),
    ).toEqual(["native prompt"]);
  });

  test("reads a chunked full.jsonl when no compact transcript is listed", async () => {
    const db = createTestDb();
    const git = new FakeGit(clock);
    const repositoryId = "rep_chunked" as RepositoryId;
    const changeId = "chg_chunked" as ChangeId;
    const context = "proj.context";
    git.createRepo(context);

    const chunk0 = [fullLine("user", "chunk0 prompt"), fullLine("assistant", "chunk0 reply")];
    const chunk1 = [fullLine("user", "chunk1 prompt")];
    const ckpt1 = git.push(
      context,
      "ckpt1",
      chunkedFullTranscriptCheckpoint("ck1", "sess-chunked", chunk0, chunk1, 0),
      { message: "Checkpoint: ck1" },
    );

    await seedChange(db, repositoryId, changeId, [{ sha: "a".repeat(40), checkpointIds: ["ck1"] }]);
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

    expect(capture.sessions).toHaveLength(1);
    expect(
      capture.sessions[0]?.turns.filter((turn) => turn.kind === "prompt").map((turn) => turn.text),
    ).toEqual(["chunk0 prompt", "chunk1 prompt"]);
  });

  test("combines attribution across checkpoints of the same session instead of taking the last", async () => {
    const db = createTestDb();
    const git = new FakeGit(clock);
    const repositoryId = "rep_attribution" as RepositoryId;
    const changeId = "chg_attribution" as ChangeId;
    const context = "proj.context";
    git.createRepo(context);

    const line1 = compactLine("user", "first");
    const line2 = compactLine("user", "second");
    const ckpt1 = git.push(
      context,
      "ckpt1",
      checkpointFiles("ck1", "sess-A", [line1], 0, {
        agent_lines: 10,
        agent_removed: 0,
        human_added: 1,
        human_modified: 0,
        human_removed: 0,
        agent_percentage: 90.9,
      }),
      { message: "Checkpoint: ck1" },
    );
    const ckpt2 = git.push(
      context,
      "ckpt2",
      checkpointFiles("ck2", "sess-A", [line1, line2], 1, {
        agent_lines: 5,
        agent_removed: 0,
        human_added: 0,
        human_modified: 0,
        human_removed: 0,
        agent_percentage: 100,
      }),
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

    // 10+5 agent lines, 1+0 human lines: 15 of 16 is 93.75%, not either checkpoint's own figure.
    expect(capture.sessions[0]?.attribution).toEqual({
      agentLines: 15,
      humanLines: 1,
      agentPercentage: 93.75,
    });
  });
});

describe("recordCheckpointPush", () => {
  test("upserts: a second push to the same checkpoint keeps firstSeenAt", async () => {
    const db = createTestDb();
    const repositoryId = "rep_rec" as RepositoryId;
    const push1: Push = {
      repoName: "proj.context",
      ref: "refs/entire/checkpoints/k1/ck1",
      before: "0".repeat(40),
      after: "a".repeat(40),
    };

    const first = await recordCheckpointPush(
      { db, clock: { now: () => 100 } },
      repositoryId,
      "ck1",
      push1,
    );
    expect(first).toEqual({
      checkpointId: "ck1",
      repositoryId,
      ref: push1.ref,
      tipSha: push1.after,
      firstSeenAt: 100,
      updatedAt: 100,
    });

    const push2 = { ...push1, after: "b".repeat(40) };
    const second = await recordCheckpointPush(
      { db, clock: { now: () => 200 } },
      repositoryId,
      "ck1",
      push2,
    );
    expect(second.firstSeenAt).toBe(100);
    expect(second.updatedAt).toBe(200);
    expect(second.tipSha).toBe(push2.after);

    const rows = await db.select().from(schema.checkpoints);
    expect(rows).toHaveLength(1);
  });
});

describe("missingCheckpoints", () => {
  test("reports only the checkpoints that have not arrived", async () => {
    const db = createTestDb();
    const repositoryId = "rep_missing2" as RepositoryId;
    const changeId = "chg_missing2" as ChangeId;
    await seedChange(db, repositoryId, changeId, [
      { sha: "a".repeat(40), checkpointIds: ["ck1", "ck2"] },
    ]);
    await db.insert(schema.checkpoints).values([
      {
        repositoryId,
        checkpointId: "ck1",
        ref: "x",
        tipSha: "a".repeat(40),
        firstSeenAt: 0,
        updatedAt: 0,
      },
    ]);

    expect(await missingCheckpoints({ db }, changeId)).toEqual(["ck2"]);
  });
});

describe("condense", () => {
  test("collapses tool runs and keeps prompts and assistant text", () => {
    const capture: ChangeCapture = {
      changeId: "chg_condense" as ChangeId,
      sessions: [
        {
          changeId: "chg_condense" as ChangeId,
          agentSessionId: "sess-1",
          agent: "claude-code",
          model: "claude-sonnet-5",
          checkpointIds: ["ck1"],
          turns: [
            { kind: "prompt", text: "do the thing", at: null },
            { kind: "tool", text: "Bash: ls", at: null },
            { kind: "tool", text: "Bash: pwd", at: null },
            { kind: "assistant", text: "done", at: null },
          ],
          attribution: null,
        },
      ],
      missingCheckpointIds: [],
    };

    const text = condense(capture);

    expect(text).toContain("## session sess-1 (claude-code)");
    expect(text).toContain("[user]\ndo the thing");
    expect(text).toContain("[tools]");
    expect(text).toContain("Bash: ls");
    expect(text).toContain("Bash: pwd");
    expect(text).toContain("[assistant]\ndone");
  });
});

describe("createCapture", () => {
  test("wires the CapturePort over the functions above", async () => {
    const db = createTestDb();
    const git = new FakeGit(clock);
    const port = createCapture({ db, git, clock });

    const push: Push = {
      repoName: "proj.context",
      ref: "refs/entire/checkpoints/k1/ck1",
      before: "0".repeat(40),
      after: "a".repeat(40),
    };
    const recorded = await port.recordCheckpoint("rep_wire" as RepositoryId, "ck1", push);
    expect(recorded.checkpointId).toBe("ck1");

    expect(await port.missingCheckpoints("chg_wire" as ChangeId)).toEqual([]);

    const capture = await port.read("chg_wire" as ChangeId);
    expect(capture).toEqual({ changeId: "chg_wire", sessions: [], missingCheckpointIds: [] });
    expect(port.condense(capture)).toBe("");
    expect(
      port.settingsFiles({ contextRepoPath: "git/ns/proj.context" })[".entire/settings.json"],
    ).toContain("artifacts");
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

    expect((files[".entire/.gitignore"] ?? "").trim().split("\n")).toEqual([
      "tmp/",
      "settings.local.json",
      "metadata/",
      "logs/",
      "redactors/local/",
    ]);

    const hooks = JSON.parse(files[".claude/settings.json"] ?? "{}");
    expect(Object.keys(hooks.hooks).sort()).toEqual(
      [
        "PostToolUse",
        "PreToolUse",
        "SessionEnd",
        "SessionStart",
        "Stop",
        "SubagentStop",
        "UserPromptSubmit",
      ].sort(),
    );
    // Eight entries total: PostToolUse carries two (Agent, TaskCreate|TaskUpdate).
    expect(hooks.hooks.PostToolUse).toHaveLength(2);
    expect(hooks.hooks.UserPromptSubmit[0].hooks[0].command).toContain("user-prompt-submit");
  });
});
