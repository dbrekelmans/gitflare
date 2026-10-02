import {
  classifyPush,
  type Decision,
  ForgeError,
  mergeReadiness,
  type Push,
  sectionApprovalState,
  sectionContentHash,
  sectionStats,
  sha1,
} from "@gitflare/core";
import { EXIT_NOT_LAUNCHED } from "@gitflare/core/ports";
import { budgetSummary, changeCost, changeEventsAfter, schema } from "@gitflare/db";
import { createTestDb } from "@gitflare/db/testing";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { buildDemoGit, demo, demoChanges, demoFiles, demoUsers } from "./demo";
import { lineDiff } from "./demo/diff";
import { createFixtureApi } from "./fixture-api";
import { createDemoPorts, createFakePorts, fakeEmbedding } from "./index";
import { seedDemo } from "./seed";

describe("fake git host", () => {
  it("hashes like git", () => {
    expect(sha1("")).toBe("da39a3ee5e6b4b0d3255bfef95601890afd80709");
    expect(sha1("The quick brown fox jumps over the lazy dog")).toBe(
      "2fd4e1c67a2d28fced849ee1bb76e7391b93eb12",
    );
  });

  it("pushes, reads back and walks trees", async () => {
    const { git } = createFakePorts();
    await git.createRepo("app");
    const push = git.push("app", "main", { "README.md": "hi\n", "src/a.ts": "a\n" });
    expect(push).toMatchObject({ repoName: "app", ref: "refs/heads/main" });
    expect(await git.resolveRef("app", "main")).toBe(push.after);
    expect(await git.text("app", "main", "src/a.ts")).toBe("a\n");
    const commit = await git.readCommit("app", push.after);
    const root = await git.readTree("app", commit?.treeSha ?? "");
    expect(root?.map((entry) => [entry.name, entry.type])).toEqual([
      ["README.md", "blob"],
      ["src", "tree"],
    ]);
    // The empty blob's well-known id proves objects are addressed the way git addresses them.
    git.push("app", "main", { empty: "" });
    const tree = await git.readTree(
      "app",
      (await git.log("app", { ref: "main" }))[0]?.treeSha ?? "",
    );
    expect(tree?.find((entry) => entry.name === "empty")?.sha).toBe(
      "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391",
    );
  });

  it("forks the default branch, merges back, and reports conflicts", async () => {
    const { git } = createFakePorts();
    await git.createRepo("app");
    git.push("app", "main", { "a.txt": "1\n", "b.txt": "1\n" });
    await git.forkRepo("app", "app.fork.x");
    const work = git.push("app.fork.x", "work", { "a.txt": "2\n" });
    expect(classifyPush(work).kind).toBe("change");

    git.push("app", "main", { "b.txt": "2\n" });
    const merged = await git.merge({
      target: { repo: "app", branch: "main" },
      source: { repo: "app.fork.x", sha: work.after },
      message: "Merge",
      author: { name: "gitflare", email: "g@example.com" },
    });
    expect(merged.status).toBe("merged");
    expect(await git.text("app", "main", "a.txt")).toBe("2\n");
    expect(await git.text("app", "main", "b.txt")).toBe("2\n");

    const clash = git.push("app.fork.x", "work", { "b.txt": "3\n" });
    expect(
      await git.merge({
        target: { repo: "app", branch: "main" },
        source: { repo: "app.fork.x", sha: clash.after },
        message: "Merge",
        author: { name: "gitflare", email: "g@example.com" },
      }),
    ).toEqual({ status: "conflict", paths: ["b.txt"] });
  });

  it("can hold a fork as not ready, the way a slow copy looks", async () => {
    const { git, provisioning } = createFakePorts();
    await git.createRepo("app");
    git.push("app", "main", { a: "1" });
    git.holdCopies = true;
    const fork = await git.forkRepo("app", "app.fork.x");
    expect(fork.status).toBe("forking");
    expect(await git.resolveRef("app.fork.x", "main")).toBeNull();
    git.finish("app.fork.x");
    expect((await git.getRepo("app.fork.x"))?.status).toBe("ready");
    expect(await git.resolveRef("app.fork.x", "main")).not.toBeNull();

    await provisioning.forkSession("ses_1");
    expect(provisioning.forks).toEqual(["ses_1"]);
  });

  it("refuses a commit when the branch moved, and bounds token lifetimes", async () => {
    const { git } = createFakePorts();
    await git.createRepo("app");
    const first = git.push("app", "main", { a: "1" });
    git.push("app", "main", { a: "2" });
    const stale = {
      repo: "app",
      branch: "main",
      changes: [{ path: "a", content: "3" }],
      message: "x",
    };
    await expect(
      git.commitFiles({
        ...stale,
        expectedParent: first.after,
        author: { name: "g", email: "g@e" },
      }),
    ).rejects.toThrow(ForgeError);
    await expect(git.mintToken("app", "read", 5)).rejects.toThrow(ForgeError);
    const token = await git.mintToken("app", "write", 3600);
    expect(await git.revokeToken("app", token.id)).toBe(true);
    expect(git.tokens[0]?.revoked).toBe(true);
  });

  it("fails one commit on demand and writes nothing, then commits as usual", async () => {
    const { git } = createFakePorts();
    await git.createRepo("app");
    const commit = () =>
      git.commitFiles({
        repo: "app",
        branch: "main",
        expectedParent: null,
        changes: [{ path: "a", content: "1" }],
        message: "x",
        author: { name: "g", email: "g@e" },
      });
    git.failNextCommit();
    await expect(commit()).rejects.toMatchObject({ code: "conflict" });
    expect(await git.resolveRef("app", "main")).toBeNull();
    const { sha } = await commit();
    expect(await git.resolveRef("app", "main")).toBe(sha);
  });

  it("raises a push for gitflare's own commits when asked to, as Artifacts does", async () => {
    const { git } = createFakePorts();
    await git.createRepo("app");
    const raised: Push[] = [];
    git.onPush = async (push) => void raised.push(push);
    const { sha } = await git.commitFiles({
      repo: "app",
      branch: "fix",
      expectedParent: null,
      changes: [{ path: "a", content: "1" }],
      message: "x",
      author: { name: "g", email: "g@e" },
    });
    expect(raised).toEqual([
      { repoName: "app", ref: "refs/heads/fix", before: raised[0]?.before, after: sha },
    ]);
    // A push a test makes by hand is the test's to deliver.
    git.push("app", "fix", { a: "2" });
    expect(raised).toHaveLength(1);
  });
});

describe("other fakes", () => {
  it("answers model calls from a script and validates structured output", async () => {
    const { models } = createFakePorts();
    const schema = z.object({ statement: z.string() });
    const request = {
      model: "m",
      messages: [{ role: "user" as const, content: "derive" }],
      maxOutputTokens: 100,
      attribution: { agent: "intent" as const },
      output: { name: "intent", schema },
    };
    models.reply("intent", { output: { statement: "Cap invites." } });
    const result = await models.generate(request);
    expect(result.output.statement).toBe("Cap invites.");
    expect(result.costMicroUsd).toBeGreaterThan(0);
    models.reply("intent", { output: { nope: true } });
    await expect(models.generate(request)).rejects.toMatchObject({ code: "invalid_output" });
    await expect(models.generate(request)).rejects.toThrow(/no reply scripted/);
    models.fail("m");
    await expect(models.generate(request)).rejects.toMatchObject({ code: "budget_exceeded" });
  });

  it("accounts an embedding like any other call, and can fail one", async () => {
    const { models } = createFakePorts();
    const request = {
      model: "e",
      texts: ["one two", "three"],
      attribution: { agent: "decisions" },
    };
    const result = await models.embed({ ...request, attribution: { agent: "decisions" } });
    expect(result.vectors).toHaveLength(2);
    expect(result.usage).toEqual({
      inputTokens: 3,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    expect(result.gatewayLogId).toBe("log_embed_1");
    models.fail("e", "unavailable");
    await expect(
      models.embed({ ...request, attribution: { agent: "decisions" } }),
    ).rejects.toMatchObject({ code: "unavailable" });
  });

  it("embeds related texts close together", () => {
    const dot = (a: number[], b: number[]) =>
      a.reduce((sum, value, i) => sum + value * (b[i] ?? 0), 0);
    const rule = fakeEmbedding("rate limits use a fixed window");
    expect(dot(rule, fakeEmbedding("a fixed window rate limit"))).toBeGreaterThan(
      dot(rule, fakeEmbedding("format dates with moment")),
    );
  });

  it("records sandbox commands and answers them from handlers", async () => {
    const { sandboxes } = createFakePorts();
    sandboxes.onCommand("pnpm test", { exitCode: 1, stdout: "1 failed" });
    const sandbox = sandboxes.get("sbx_1");
    await expect(sandbox.exec(["true"])).rejects.toMatchObject({ code: "unavailable" });
    await sandbox.start({ image: "workspace", instance: "standard-1", egress: [] });
    expect((await sandbox.exec(["sh", "-c", "pnpm test"])).exitCode).toBe(1);
    await sandbox.spawn("ci", ["sh", "-c", "pnpm test"]);
    expect(await sandbox.processStatus("ci")).toEqual({ state: "exited", exitCode: 1 });
    expect((await sandbox.readLog("ci", "stdout", 2)).text).toBe("failed");
    expect(sandboxes.commands).toHaveLength(2);
  });

  it("refuses what the real sandbox refuses once it has stopped or was lost", async () => {
    const { sandboxes } = createFakePorts();
    const sandbox = sandboxes.get("sbx_1");
    const options = { image: "workspace", instance: "standard-1", egress: [] } as const;
    await sandbox.start({ ...options, egress: [] });
    await expect(sandbox.start({ ...options, egress: [] })).rejects.toMatchObject({
      code: "conflict",
    });
    await sandbox.spawn("ci", ["true"]);

    await sandboxes.lose("sbx_1");
    expect(await sandbox.isRunning()).toBe(false);
    const refused = { code: "unavailable" };
    await expect(sandbox.processStatus("ci")).rejects.toMatchObject(refused);
    await expect(sandbox.readLog("ci", "stdout", 0)).rejects.toMatchObject(refused);
    await expect(sandbox.exec(["true"])).rejects.toMatchObject(refused);
    await expect(sandbox.spawn("ci", ["true"])).rejects.toMatchObject(refused);
    await expect(sandbox.readFile("/x")).rejects.toMatchObject(refused);
    await expect(sandbox.writeFile("/x", "")).rejects.toMatchObject(refused);
    await expect(sandbox.snapshot()).rejects.toMatchObject(refused);
    // Stopping twice is fine, and a stopped sandbox can be started again, empty.
    await sandbox.stop();
    await sandbox.start({ ...options, egress: [] });
    expect(await sandbox.processStatus("ci")).toBeNull();
  });

  it("names open Internet access and refuses a host grant of *", async () => {
    const { sandboxes } = createFakePorts();
    const options = { image: "workspace", instance: "standard-1" } as const;
    await expect(
      sandboxes.get("sbx_1").start({ ...options, egress: [{ kind: "host", host: "*" }] }),
    ).rejects.toMatchObject({ code: "invalid" });
    await expect(
      sandboxes.get("sbx_1").start({
        ...options,
        openInternet: true,
        egress: [{ kind: "git", repo: "app", scope: "read" }],
      }),
    ).rejects.toMatchObject({ code: "invalid" });
    expect(await sandboxes.get("sbx_1").isRunning()).toBe(false);
    await sandboxes.get("sbx_1").start({ ...options, egress: [], openInternet: true });
    expect(sandboxes.startOptions("sbx_1")?.openInternet).toBe(true);
  });

  it("keeps a process running until told to finish, and tells a failed command from a lost sandbox", async () => {
    const { sandboxes } = createFakePorts();
    sandboxes.onCommand("agent", { running: true, stdout: "thinking\n" });
    sandboxes.onCommand("no-such-binary", { exitCode: EXIT_NOT_LAUNCHED, stderr: "not found" });
    const sandbox = sandboxes.get("sbx_1");
    await sandbox.start({ image: "workspace", instance: "standard-1", egress: [] });

    await sandbox.spawn("turn", ["agent"]);
    expect(await sandbox.processStatus("turn")).toEqual({ state: "running" });
    expect((await sandbox.readLog("turn", "stdout", 0)).text).toBe("thinking\n");
    await expect(sandbox.spawn("turn", ["agent"])).rejects.toMatchObject({ code: "conflict" });
    sandboxes.finish("sbx_1", "turn", { exitCode: 2, stdout: "thinking\ndone\n" });
    expect(await sandbox.processStatus("turn")).toEqual({ state: "exited", exitCode: 2 });
    expect((await sandbox.readLog("turn", "stdout", 9)).text).toBe("done\n");

    // A command that cannot be launched is a result; the sandbox is still there.
    expect(await sandbox.exec(["no-such-binary"])).toEqual({
      exitCode: EXIT_NOT_LAUNCHED,
      stdout: "",
      stderr: "not found",
    });
    expect(await sandbox.isRunning()).toBe(true);
  });

  it("launches a hosted session once, only when its fork is ready, and prompts only after", async () => {
    const { cloudSessions } = createFakePorts();
    const ready = new Set<string>();
    cloudSessions.forkReady = (sessionId) => ready.has(sessionId);
    await expect(cloudSessions.launch("ses_1", "Do it.")).rejects.toMatchObject({
      code: "not_ready",
    });
    await expect(cloudSessions.prompt("ses_1", "And this.")).rejects.toMatchObject({
      code: "not_ready",
    });
    ready.add("ses_1");
    await cloudSessions.launch("ses_1", "Do it.");
    // The provisioning step is retried: the prompt is not sent a second time.
    await cloudSessions.launch("ses_1", "Do it.");
    await cloudSessions.prompt("ses_1", "And this.");
    expect(cloudSessions.launches).toEqual([{ sessionId: "ses_1", prompt: "Do it." }]);
    expect((await cloudSessions.events("ses_1", 0)).map((event) => event.type)).toEqual([
      "prompt",
      "prompt",
    ]);
  });

  it("records the attempt a re-run was asked to run", async () => {
    const { pipeline } = createFakePorts();
    await pipeline.rerunStage("chg_1", "review", 3);
    expect(pipeline.reruns).toEqual([{ changeId: "chg_1", stage: "review", attempt: 3 }]);
  });
});

describe("internal port fakes", () => {
  it("diffs two commits of the fake git host to what the demo's sections show", async () => {
    const ports = createDemoPorts();
    const change = demoChanges.review;
    const diff = await ports.diffs.between(
      demo.git.repos.forks.review,
      change.baseSha,
      change.headSha,
    );
    for (const section of demo.sections.filter((s) => s.changeId === change.id)) {
      expect(sectionContentHash(diff, section.files)).toBe(section.contentHash);
    }
    expect(
      await ports.diffs.mergeBase(demo.git.repos.forks.review, change.headSha, change.baseSha),
    ).toBe(change.baseSha);
    expect(ports.diffs.format(diff)).toContain("+++ b/src/invites/rate-limit.ts");
  });

  it("serves the demo's capture and ranks decisions by meaning", async () => {
    const ports = createDemoPorts();
    const capture = await ports.capture.read(demoChanges.review.id);
    expect(capture.sessions[0]?.checkpointIds).toEqual(demo.checkpoints.map((c) => c.checkpointId));
    expect(ports.capture.condense(capture)).toContain("[prompt] Support had three workspaces");
    expect((await ports.capture.read("chg_other")).sessions).toEqual([]);

    const found = await ports.decisions.retrieve({
      repositoryId: demo.repositories[0]?.id ?? "rep_x",
      query: "a counter that is incremented and compared, kept in KV",
      limit: 2,
    });
    expect(found[0]?.decision.id).toBe("dec_counters_in_durable_objects");
    expect(found.some((entry) => entry.decision.status === "dormant")).toBe(false);
  });
});

describe("fake decision record", () => {
  it("leaves out a path-scoped decision for a change that touches none of its paths", async () => {
    const { decisions } = createFakePorts();
    const [general] = demo.decisions;
    if (!general) throw new Error("the demo has no decisions");
    const scoped: Decision = {
      ...general,
      id: "dec_scoped",
      scope: { kind: "paths", globs: ["src/billing/**"] },
    };
    decisions.add(general, scoped);
    const retrieve = (paths?: string[]) =>
      decisions
        .retrieve({ repositoryId: general.repositoryId, query: general.statement, limit: 5, paths })
        .then((found) => found.map((entry) => entry.decision.id).sort());
    expect(await retrieve()).toEqual(["dec_scoped", general.id].sort());
    expect(await retrieve(["src/billing/invoice.ts"])).toEqual(["dec_scoped", general.id].sort());
    expect(await retrieve(["src/invites/send.ts"])).toEqual([general.id]);
  });

  it("learns nothing from a thread unless a test says what", async () => {
    const { decisions } = createFakePorts();
    const [lesson] = demo.decisions;
    if (!lesson) throw new Error("the demo has no decisions");
    expect(await decisions.learnFromThread("thr_1")).toBeNull();
    decisions.lessons.set("thr_2", lesson);
    expect(await decisions.learnFromThread("thr_2")).toBe(lesson);
    expect(decisions.learnedFrom).toEqual(["thr_1", "thr_2"]);
  });
});

describe("demo fixture", () => {
  it("names commits that exist in the demo's repositories", async () => {
    const { git, repos, shas } = buildDemoGit();
    expect(demo.git.shas).toEqual(shas);
    expect(await git.resolveRef(repos.main, "main")).toBe(shas.base);
    expect(await git.resolveRef(repos.forks.review, "rate-limit-invites")).toBe(
      demoChanges.review.headSha,
    );
    expect(
      await git.text(repos.forks.review, demoChanges.review.headSha, "src/invites/rate-limit.ts"),
    ).toBe(demoFiles.head["src/invites/rate-limit.ts"]);
    expect(await git.resolveRef(repos.context, demo.git.checkpointRef)).toBe(shas.checkpoint);
    const log = await git.log(repos.forks.review, { ref: "rate-limit-invites", limit: 3 });
    expect(log.map((commit) => commit.sha).reverse()).toEqual(shas.review);
  });

  it("has section diffs that add up to the files they present", () => {
    const diff = lineDiff("f", "a\nb\nc\n", "a\nB\nc\nd\n");
    expect(diff).toMatchObject({ insertions: 2, deletions: 1, status: "modified" });
    expect(diff.hunks[0]?.lines.map((line) => `${line.kind[0]}${line.text}`)).toEqual([
      "ca",
      "db",
      "aB",
      "cc",
      "ad",
    ]);
    for (const section of demo.sections) {
      const files = demo.sectionDiffs[section.id] ?? [];
      expect(files.map((file) => file.path).sort()).toEqual(
        section.files.map((f) => f.path).sort(),
      );
      expect(files.every((file) => file.hunks.length > 0)).toBe(true);
    }
  });

  it("tells the story it claims to: approved, pending, withdrawn, and one open comment", () => {
    const change = demoChanges.review;
    const sections = demo.sections.filter((s) => s.changeId === change.id);
    const approvals = demo.approvals.filter((a) => a.changeId === change.id);
    expect(sections.map((s) => sectionApprovalState(s, approvals))).toEqual([
      "approved",
      "pending",
      "withdrawn",
      "approved",
    ]);
    const readiness = mergeReadiness({
      change,
      headStageRuns: demo.stageRuns.filter((run) => run.revisionId === change.headRevisionId),
      sections,
      approvals,
      threads: demo.threads,
    });
    expect(readiness.blockers).toEqual([
      { kind: "sections_unapproved", sectionIds: ["sec_demo12route", "sec_demo12tests"] },
      { kind: "comments_open", threadIds: ["thr_demo12rollover"] },
    ]);
  });
});

describe("fixture API", () => {
  const ctx = { user: demoUsers.maya };

  it("serves the demo and lists what waits on the caller", async () => {
    const api = createFixtureApi();
    const inbox = await api.changes.list(ctx, { scope: "inbox" });
    expect(inbox.map((item) => item.change.number)).toEqual([12]);
    const detail = await api.changes.get(ctx, { changeId: demoChanges.review.id });
    expect(detail.intent?.grade).toBe("transcript");
    expect(detail.capture).toMatchObject({ state: "present", missingCheckpointIds: [] });
    expect(detail.capture.sessions[0]?.agent).toBe("claude-code");
    const cloud = await api.changes.get(ctx, { changeId: demoChanges.cloud.id });
    expect(cloud.capture.state).toBe("none");
    // Nothing was captured for the hosted session, so its intent can only come from the diff.
    expect(cloud.intent?.grade).toBe("diff");
    expect(detail.sections).toHaveLength(4);
    expect(detail.cost.totalMicroUsd).toBeGreaterThan(0);
    expect((await api.threads.list(ctx, { changeId: demoChanges.review.id })).length).toBe(4);
    expect(
      (await api.decisions.list(ctx, { repoSlug: "atlas-web", status: "dormant" })).length,
    ).toBe(1);
  });

  it("lets a change merge once its blockers are cleared, and not before", async () => {
    const api = createFixtureApi();
    const changeId = demoChanges.review.id;
    await expect(api.changes.merge(ctx, { changeId })).rejects.toMatchObject({ code: "not_ready" });
    await api.changes.approveSection(ctx, { changeId, sectionId: "sec_demo12route" });
    await api.changes.approveSection(ctx, { changeId, sectionId: "sec_demo12tests" });
    const settled = await api.threads.dismiss(ctx, {
      threadId: "thr_demo12rollover",
      classification: "not_a_problem",
      reason: "Covered by the window arithmetic test upstream.",
    });
    expect(settled.thread.status).toBe("dismissed");
    const merged = await api.changes.merge(ctx, { changeId });
    expect(merged.change.status).toBe("merged");
    // A second API instance starts from the untouched fixture.
    expect((await createFixtureApi().changes.get(ctx, { changeId })).change.status).toBe("ready");
  });

  it("checks permissions", async () => {
    const api = createFixtureApi();
    const jonas = { user: demoUsers.jonas };
    await expect(api.account.prepareWorkspace(jonas)).rejects.toMatchObject({ code: "forbidden" });
    await api.account.prepareWorkspace(ctx);
    expect((await api.account.getSettings(ctx)).workspace.snapshot).not.toBeNull();
    await expect(
      api.repositories.create(jonas, { slug: "new-repo", description: "" }),
    ).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(
      api.sessions.prompt(jonas, { sessionId: "ses_01k6maya", text: "hi" }),
    ).rejects.toMatchObject({
      code: "forbidden",
    });
  });
});

describe("fixture API, round two", () => {
  const ctx = { user: demoUsers.maya };
  const jonas = { user: demoUsers.jonas };

  it("hands out copies, so a later write does not change what a caller already holds", async () => {
    const api = createFixtureApi();
    const changeId = demoChanges.review.id;
    const before = await api.changes.get(ctx, { changeId });
    const approved = before.sections.filter((s) => s.approvalState === "approved").length;
    await api.changes.approveSection(ctx, { changeId, sectionId: "sec_demo12route" });
    expect(before.sections.filter((s) => s.approvalState === "approved")).toHaveLength(approved);
    const after = await api.changes.get(ctx, { changeId });
    expect(after.sections.filter((s) => s.approvalState === "approved")).toHaveLength(approved + 1);
  });

  it("says who merged a change and who settled a comment, when a person did", async () => {
    const api = createFixtureApi();
    const merged = await api.changes.get(ctx, { changeId: demoChanges.merged.id });
    expect(merged.mergedBy?.id).toBe(demoChanges.merged.mergedBy);
    expect((await api.changes.get(ctx, { changeId: demoChanges.review.id })).mergedBy).toBeNull();

    const threads = await api.threads.list(ctx, { changeId: demoChanges.review.id });
    const settledBy = Object.fromEntries(threads.map((t) => [t.thread.id, t.settledBy?.name]));
    expect(settledBy).toEqual({
      // Resolved by the agent: settled, by nobody.
      thr_demo12key: undefined,
      thr_demo12window: demoUsers.jonas.name,
      thr_demo12rollover: undefined,
      thr_demo12queue: undefined,
    });
    // A person who settles without ever posting in the thread is still named.
    const rollover = threads.find((t) => t.thread.id === "thr_demo12rollover");
    const silent = Object.values(demoUsers).find(
      (user) => !rollover?.messages.some((m) => m.user?.id === user.id),
    );
    if (!silent) throw new Error("everyone has posted in the demo's open comment");
    const resolved = await api.threads.resolve(
      { user: silent },
      { threadId: "thr_demo12rollover" },
    );
    expect(resolved.settledBy).toMatchObject({ id: silent.id, name: silent.name });
  });

  it("has no remote for a session whose fork is gone", async () => {
    const api = createFixtureApi();
    const [mine] = await api.sessions.listMine(ctx);
    if (!mine) throw new Error("the demo's viewer has no session");
    expect(mine.pushRemote).toMatch(/\.git$/);
    const data = structuredClone(demo);
    for (const session of data.sessions) session.forkDeletedAt = demo.now;
    const [gone] = await createFixtureApi(data).sessions.listMine(ctx);
    expect(gone?.pushRemote).toBeNull();
  });

  it("frees the slug of a repository whose import failed, and no other", async () => {
    const data = structuredClone(demo);
    data.repositories.push({
      ...demo.repositories[0],
      id: "rep_failed",
      slug: "broken-import",
      headSha: null,
      readyAt: null,
      importFailedAt: demo.now,
      importError: "The source repository could not be read (404).",
    } as (typeof demo.repositories)[number]);
    const api = createFixtureApi(data);

    const failed = await api.repositories.get(ctx, { repoSlug: "broken-import" });
    expect(failed.repository.importError).toMatch(/404/);
    expect(failed).toMatchObject({ remote: null, contextRemote: null });

    const again = await api.repositories.create(ctx, { slug: "broken-import", description: "" });
    expect(again.repository).toMatchObject({ importFailedAt: null, importError: null });
    expect(again.repository.id).not.toBe("rep_failed");
    expect(
      (await api.repositories.list(ctx)).filter((r) => r.repository.slug === "broken-import"),
    ).toHaveLength(1);
    await expect(
      api.repositories.create(ctx, { slug: "atlas-web", description: "" }),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("reverts a decision's whole wording, and names the people in its history", async () => {
    const api = createFixtureApi();
    const decisionId = "dec_thin_routes";
    const { decision: before, repository } = await api.decisions.get(ctx, { decisionId });
    expect(repository.slug).toBe("atlas-web");

    const edited = await api.decisions.edit(jonas, {
      decisionId,
      title: "Routes only route",
      statement: "A route parses and responds.",
      rationale: "Shorter.",
    });
    const [reshaped] = edited.events;
    expect(reshaped).toMatchObject({
      kind: "reshaped",
      user: { name: demoUsers.jonas.name },
      wording: {
        before: { title: before.title, statement: before.statement, rationale: before.rationale },
        after: { title: "Routes only route", rationale: "Shorter." },
      },
    });
    // An event gitflare recorded itself has nobody behind it.
    expect(edited.events.at(-1)).toMatchObject({ kind: "created", user: null });

    const reverted = await api.decisions.revert(ctx, {
      decisionId,
      eventId: reshaped?.id ?? "dev_x",
    });
    expect(reverted.decision).toMatchObject({
      title: before.title,
      statement: before.statement,
      rationale: before.rationale,
    });
    expect(reverted.events[0]).toMatchObject({ kind: "reverted", user: { id: ctx.user.id } });
  });

  it("records nothing for an edit that changes nothing, and refuses a revert with nothing to put back", async () => {
    const api = createFixtureApi();
    const decisionId = "dec_no_secrets_in_logs";
    const { decision, events } = await api.decisions.get(ctx, { decisionId });

    const same = await api.decisions.edit(ctx, {
      decisionId,
      title: decision.title,
      statement: decision.statement,
      rationale: decision.rationale,
    });
    expect(same.events).toHaveLength(events.length);

    // A title-only edit is a rewording too, and reverting it restores the title.
    const retitled = await api.decisions.edit(ctx, {
      decisionId,
      title: "No secrets in logs",
      statement: decision.statement,
      rationale: decision.rationale,
    });
    const eventId = retitled.events[0]?.id ?? "dev_x";
    const back = await api.decisions.revert(ctx, { decisionId, eventId });
    expect(back.decision.title).toBe(decision.title);
    // Already back: reverting the same edit again has nothing to change.
    await expect(api.decisions.revert(ctx, { decisionId, eventId })).rejects.toMatchObject({
      code: "conflict",
    });
    await expect(
      api.decisions.revert(ctx, { decisionId, eventId: "dev_ns2" }),
    ).rejects.toMatchObject({ code: "invalid" });
    expect((await api.decisions.get(ctx, { decisionId })).events).toHaveLength(events.length + 2);
  });

  it("keeps a started hosted session's first prompt as its launch", async () => {
    const api = createFixtureApi();
    const started = await api.sessions.start(ctx, {
      repoSlug: "atlas-web",
      kind: "cloud",
      title: "Export",
      prompt: "Add the export route.",
    });
    expect(
      await api.sessions.events(ctx, { sessionId: started.session.id, after: 0 }),
    ).toMatchObject([{ seq: 1, type: "prompt", text: "Add the export route." }]);
  });
});

describe("demo seed", () => {
  it("fills every table once and agrees with the fixture", async () => {
    const db = createTestDb();
    expect(await seedDemo(db)).toBe(true);
    expect(await seedDemo(db)).toBe(false);
    expect((await db.select().from(schema.changes)).length).toBe(demo.changes.length);
    expect((await db.select().from(schema.threadMessages)).length).toBe(demo.messages.length);
    expect((await db.select().from(schema.decisions)).length).toBe(demo.decisions.length);
    for (const table of Object.values(schema)) {
      if (table === schema.gitTokens) continue;
      expect((await db.select().from(table)).length).toBeGreaterThan(0);
    }
    const cost = await changeCost(db, demoChanges.review.id);
    expect(cost).toEqual(
      await createFixtureApi()
        .changes.get({ user: demoUsers.maya }, { changeId: demoChanges.review.id })
        .then((d) => d.cost),
    );
    const budget = await budgetSummary(db, demo.organisation.settings, demo.now);
    // The merged change's calls were made the month before and do not count.
    expect(budget.spentMicroUsd).toBe(
      demo.modelCalls
        .filter((call) => call.createdAt >= budget.monthStart)
        .reduce((sum, call) => sum + call.costMicroUsd, 0),
    );
    expect(budget.spentMicroUsd).toBe(4_001_000);
    // Each section is stored with the size of what it presents, as the fixture reports it.
    const detail = await createFixtureApi().changes.get(
      { user: demoUsers.maya },
      { changeId: demoChanges.review.id },
    );
    for (const row of await db.select().from(schema.sections)) {
      const view = detail.sections.find((s) => s.section.id === row.id);
      if (!view) continue;
      const { filesChanged, insertions, deletions } = view;
      expect(row.stats, row.id).toEqual({ filesChanged, insertions, deletions });
      expect(row.stats).toEqual(sectionStats(demo.sectionDiffs[row.id] ?? [], row.files));
    }
    const [launch] = await db.select().from(schema.sessionLaunches);
    const [firstPrompt] = (await db.select().from(schema.cloudSessionEvents)).filter(
      (event) => event.body.type === "prompt",
    );
    expect(firstPrompt?.body).toEqual({ type: "prompt", text: launch?.prompt });
    expect(launch?.launchedAt).not.toBeNull();
    const reviewed = await db.select().from(schema.revisionReviews);
    expect(reviewed.map((review) => [review.revisionId, review.findings])).toEqual([
      ["rev_demo11a", 0],
      ["rev_demo12a", 3],
      ["rev_demo12b", 0],
    ]);
    const events = await changeEventsAfter(db, demoChanges.review.id, 0);
    expect(events.at(-1)).toEqual(
      demo.changeEvents.filter((e) => e.changeId === demoChanges.review.id).at(-1),
    );
  });

  it("gives local development the demo's viewer and repositories", async () => {
    const ports = createDemoPorts();
    expect(await ports.identity.identify()).toMatchObject({ email: demo.viewer.email });
    expect(ports.clock.now()).toBe(demo.now);
    expect(await ports.git.getRepo(demo.git.repos.main)).not.toBeNull();
  });
});
