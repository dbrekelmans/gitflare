import { classifyPush, ForgeError, mergeReadiness, sectionApprovalState } from "@gitflare/core";
import { changeEventsAfter, schema } from "@gitflare/db";
import { createTestDb } from "@gitflare/db/testing";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { buildDemoGit, demo, demoChanges, demoFiles, demoUsers } from "./demo";
import { lineDiff } from "./demo/diff";
import { createFixtureApi } from "./fixture-api";
import { createDemoPorts, createFakePorts, fakeEmbedding, sha1 } from "./index";
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
    await expect(sandbox.exec(["true"])).rejects.toThrow(/not running/);
    await sandbox.start({ image: "workspace", instance: "standard-1", egress: [] });
    expect((await sandbox.exec(["sh", "-c", "pnpm test"])).exitCode).toBe(1);
    await sandbox.spawn("ci", ["sh", "-c", "pnpm test"]);
    expect(await sandbox.processStatus("ci")).toEqual({ state: "exited", exitCode: 1 });
    expect((await sandbox.readLog("ci", "stdout", 2)).text).toBe("failed");
    expect(sandboxes.commands).toHaveLength(2);
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
