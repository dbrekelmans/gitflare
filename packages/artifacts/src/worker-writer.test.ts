import type { GitWriter } from "@gitflare/core/ports";
import { type Db, schema } from "@gitflare/db";
import { createTestDb } from "@gitflare/db/testing";
import { ManualClock } from "@gitflare/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createArtifactsGitHost } from "./host";
import { LocalArtifacts } from "./testing/local-artifacts";
import { trimPack } from "./wire";
import { createWorkerGitWriter, MergeTooLargeError } from "./worker-writer";

// These tests run real git; a slow machine needs more than the default five seconds.
vi.setConfig({ testTimeout: 30_000 });

const author = { name: "gitflare", email: "gitflare@example.test" };
const NOW = Date.UTC(2026, 9, 2, 12, 0, 0);

let artifacts: LocalArtifacts;
let db: Db;
let writer: GitWriter;

function writerWith(options: { maxMergeBytes?: number } = {}): GitWriter {
  return createWorkerGitWriter({
    git: createArtifactsGitHost(artifacts),
    db,
    fetch: artifacts.fetch,
    clock: new ManualClock(NOW),
    ...options,
  });
}

beforeEach(async () => {
  artifacts = new LocalArtifacts();
  db = createTestDb();
  writer = writerWith();
  await artifacts.create("app");
});
afterEach(() => artifacts.cleanup());

/** The files of a commit, as `path` → content. */
function files(repo: string, rev: string): Record<string, string> {
  const paths = artifacts.git(repo, "ls-tree", "-r", "--name-only", rev);
  return Object.fromEntries(
    paths
      .split("\n")
      .filter(Boolean)
      .map((path) => [path, artifacts.git(repo, "show", `${rev}:${path}`)]),
  );
}

describe("commitFiles", () => {
  it("creates a branch with a first commit git accepts", async () => {
    const { sha } = await writer.commitFiles({
      repo: "app",
      branch: "main",
      expectedParent: null,
      changes: [
        { path: ".entire/settings.json", content: "{}" },
        { path: "README.md", content: new TextEncoder().encode("hello") },
      ],
      message: "Set up",
      author,
    });
    expect(artifacts.tip("app", "main")).toBe(sha);
    expect(files("app", "main")).toEqual({ ".entire/settings.json": "{}", "README.md": "hello" });
    expect(artifacts.git("app", "log", "-1", "--format=%an <%ae> %at%n%s%n%P", sha)).toBe(
      `gitflare <gitflare@example.test> ${NOW / 1000}\nSet up`,
    );
    artifacts.git("app", "fsck", "--strict");
  });

  it("commits on top of a branch without cloning, touching only the changed paths", async () => {
    const base = artifacts.commit("app", "main", {
      "README.md": "one\n",
      "src/a.ts": "a\n",
      "src/deep/b.ts": "b\n",
      "src/deep/c.ts": "c\n",
      "docs/guide.md": "guide\n",
      "old/only.txt": "x\n",
    });
    const docsTree = artifacts.git("app", "rev-parse", `${base}:docs`);
    artifacts.requests.length = 0;

    const { sha } = await writer.commitFiles({
      repo: "app",
      branch: "main",
      expectedParent: base,
      changes: [
        { path: "src/deep/b.ts", content: "b2\n" },
        { path: "src/new/d.ts", content: "d\n" },
        { path: "src/deep/c.ts", delete: true },
        { path: "old/only.txt", delete: true },
        { path: "never/was.txt", delete: true },
      ],
      message: "Change a few files",
      author,
    });

    expect(artifacts.tip("app", "main")).toBe(sha);
    expect(artifacts.git("app", "rev-parse", `${sha}^`)).toBe(base);
    expect(files("app", sha)).toEqual({
      "README.md": "one",
      "docs/guide.md": "guide",
      "src/a.ts": "a",
      "src/deep/b.ts": "b2",
      "src/new/d.ts": "d",
    });
    // An untouched directory keeps its tree, and a directory left empty is gone.
    expect(artifacts.git("app", "rev-parse", `${sha}:docs`)).toBe(docsTree);
    artifacts.git("app", "fsck", "--strict");
    // One request: the push. Nothing was fetched.
    expect(artifacts.requests).toEqual(["POST app git-receive-pack"]);
  });

  it("keeps an executable executable when its content is replaced", async () => {
    const blob = artifacts.gitWith("app", "", "hash-object", "-w", "--stdin");
    const tree = artifacts.gitWith("app", `100755 blob ${blob}\trun.sh\n`, "mktree");
    const commit = artifacts.git("app", "commit-tree", tree, "-m", "Add a script");
    artifacts.git("app", "update-ref", "refs/heads/main", commit);

    const { sha } = await writer.commitFiles({
      repo: "app",
      branch: "main",
      expectedParent: commit,
      changes: [{ path: "run.sh", content: "#!/bin/sh\n" }],
      message: "Fill in",
      author,
    });
    expect(artifacts.git("app", "ls-tree", sha)).toMatch(/^100755 blob [0-9a-f]{40}\trun\.sh$/);
  });

  it("refuses to overwrite a branch that moved, before and during the push", async () => {
    const base = artifacts.commit("app", "main", { a: "1" });
    const moved = artifacts.commit("app", "main", { a: "2" });
    const request = {
      repo: "app",
      branch: "main",
      changes: [{ path: "a", content: "3" }],
      message: "Late",
      author,
    };
    await expect(writer.commitFiles({ ...request, expectedParent: base })).rejects.toMatchObject({
      code: "conflict",
    });
    await expect(writer.commitFiles({ ...request, expectedParent: null })).rejects.toMatchObject({
      code: "conflict",
    });

    // The branch moves between the writer's read and its push: the server's
    // own compare-and-swap refuses, and that is a conflict too.
    const racing = createWorkerGitWriter({
      git: createArtifactsGitHost(artifacts),
      db,
      clock: new ManualClock(NOW),
      fetch: async (input, init) => {
        artifacts.commit("app", "main", { a: "raced" });
        return artifacts.fetch(input, init);
      },
    });
    await expect(racing.commitFiles({ ...request, expectedParent: moved })).rejects.toMatchObject({
      code: "conflict",
    });
    expect(files("app", "main")).toEqual({ a: "raced" });
  });

  it("rejects a path git cannot store", async () => {
    for (const path of ["", "a//b", "../x", ".git/config", "a/./b"]) {
      await expect(
        writer.commitFiles({
          repo: "app",
          branch: "main",
          expectedParent: null,
          changes: [{ path, content: "x" }],
          message: "Bad",
          author,
        }),
      ).rejects.toMatchObject({ code: "invalid" });
    }
  });

  it("pushes with a write token of its own and revokes it", async () => {
    await writer.commitFiles({
      repo: "app",
      branch: "main",
      expectedParent: null,
      changes: [{ path: "a", content: "1" }],
      message: "One",
      author,
    });
    const minted = artifacts.tokens.filter((token) => token.repo === "app").slice(1);
    expect(minted.map((token) => [token.scope, token.revoked])).toEqual([["write", true]]);
    // Recorded like every other token, and marked revoked there too.
    expect(await db.select().from(schema.gitTokens)).toMatchObject([
      {
        tokenId: minted[0]?.id,
        repoName: "app",
        userId: null,
        scope: "write",
        purpose: "system",
        revokedAt: NOW,
      },
    ]);
  });

  it("fails, writing nothing, when a tree on the path cannot be read", async () => {
    const base = artifacts.commit("app", "main", { "src/a.ts": "a\n", "src/b.ts": "b\n" });
    const host = createArtifactsGitHost(artifacts);
    const unreadable = createWorkerGitWriter({
      git: { ...host, readTree: async () => null },
      db,
      fetch: artifacts.fetch,
      clock: new ManualClock(NOW),
    });
    await expect(
      unreadable.commitFiles({
        repo: "app",
        branch: "main",
        expectedParent: base,
        changes: [{ path: "src/a.ts", content: "changed\n" }],
        message: "Would drop src/b.ts",
        author,
      }),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(artifacts.tip("app", "main")).toBe(base);
  });
});

describe("merge", () => {
  async function forked(): Promise<string> {
    const base = artifacts.commit("app", "main", { "a.txt": "1\n", "b.txt": "1\n" }, { at: 1000 });
    const repo = await artifacts.get("app");
    await repo.fork("app.fork.s1");
    return base;
  }
  const merge = (sha: string, using: GitWriter = writer) =>
    using.merge({
      target: { repo: "app", branch: "main" },
      source: { repo: "app.fork.s1", sha },
      message: "Merge change #1",
      author,
    });

  it("fast-forwards by relaying the fork's pack, without cloning", async () => {
    await forked();
    artifacts.commit("app.fork.s1", "work", { "a.txt": "2\n" }, { from: "main", at: 2000 });
    const tip = artifacts.commit("app.fork.s1", "work", { "c/d.txt": "new\n" }, { at: 3000 });
    artifacts.requests.length = 0;

    expect(await merge(tip)).toEqual({ status: "merged", sha: tip });
    expect(artifacts.tip("app", "main")).toBe(tip);
    expect(files("app", "main")).toEqual({ "a.txt": "2", "b.txt": "1", "c/d.txt": "new" });
    artifacts.git("app", "fsck", "--strict");
    expect(artifacts.requests).toEqual([
      "POST app.fork.s1 git-upload-pack",
      "POST app git-receive-pack",
    ]);
    // Read from the fork, write to the parent, and neither token outlives the merge.
    const used = artifacts.tokens.filter((token) => token.id !== "tok_1" && token.id !== "tok_2");
    expect(used.map((token) => [token.repo, token.scope, token.revoked])).toEqual([
      ["app", "write", true],
      ["app.fork.s1", "read", true],
    ]);
  });

  it("fast-forwards across a merge commit whose second parent is the target's tip", async () => {
    await forked();
    artifacts.commit("app.fork.s1", "work", { "a.txt": "2\n" }, { from: "main", at: 2000 });
    // Main moves on, and the session merges it into its branch: main's tip is
    // now an ancestor of the branch only through a second parent.
    const moved = artifacts.commit("app", "main", { "b.txt": "2\n" }, { at: 2500 });
    artifacts.git("app.fork.s1", "fetch", "-q", artifacts.path("app"), "main");
    const tree = artifacts.git("app.fork.s1", "merge-tree", "--write-tree", "work", moved);
    const work = artifacts.tip("app.fork.s1", "work") ?? "";
    const tip = artifacts.git(
      "app.fork.s1",
      "commit-tree",
      tree,
      "-p",
      work,
      "-p",
      moved,
      "-m",
      "Merge main",
    );
    artifacts.git("app.fork.s1", "update-ref", "refs/heads/work", tip);

    expect(await merge(tip)).toEqual({ status: "merged", sha: tip });
    expect(artifacts.tip("app", "main")).toBe(tip);
    artifacts.git("app", "fsck", "--strict");
  });

  it("reports up to date when the target already contains the commit", async () => {
    const base = await forked();
    const tip = artifacts.commit("app", "main", { "b.txt": "2\n" }, { at: 2000 });
    artifacts.requests.length = 0;
    expect(await merge(base)).toEqual({ status: "up_to_date", sha: tip });
    expect(artifacts.requests).toEqual([]);
  });

  it("makes a merge commit when both sides moved", async () => {
    await forked();
    artifacts.commit("app.fork.s1", "work", { "a.txt": "2\n" }, { from: "main", at: 2000 });
    const theirs = artifacts.commit("app.fork.s1", "work", { "new.txt": "n\n" }, { at: 2100 });
    const ours = artifacts.commit("app", "main", { "b.txt": "2\n" }, { at: 3000 });

    const result = await merge(theirs);
    expect(result.status).toBe("merged");
    const sha = result.status === "merged" ? result.sha : "";
    expect(artifacts.tip("app", "main")).toBe(sha);
    expect(artifacts.git("app", "log", "-1", "--format=%P%n%s%n%an %at", sha)).toBe(
      `${ours} ${theirs}\nMerge change #1\ngitflare ${NOW / 1000}`,
    );
    expect(files("app", "main")).toEqual({ "a.txt": "2", "b.txt": "2", "new.txt": "n" });
    artifacts.git("app", "fsck", "--strict");
  });

  it("reports the conflicting paths and leaves the target alone", async () => {
    await forked();
    const theirs = artifacts.commit(
      "app.fork.s1",
      "work",
      { "a.txt": "theirs\n", "b.txt": "2\n" },
      { from: "main", at: 2000 },
    );
    const ours = artifacts.commit("app", "main", { "a.txt": "ours\n" }, { at: 3000 });

    expect(await merge(theirs)).toEqual({ status: "conflict", paths: ["a.txt"] });
    expect(artifacts.tip("app", "main")).toBe(ours);
  });

  it("is a conflict when the target moves while a true merge is being made", async () => {
    await forked();
    const theirs = artifacts.commit(
      "app.fork.s1",
      "work",
      { "a.txt": "2\n" },
      { from: "main", at: 2000 },
    );
    artifacts.commit("app", "main", { "b.txt": "2\n" }, { at: 3000 });
    let raced = "";
    const racing = createWorkerGitWriter({
      git: createArtifactsGitHost(artifacts),
      db,
      clock: new ManualClock(NOW),
      fetch: async (input, init) => {
        if (!raced && input.includes("git-receive-pack")) {
          raced = artifacts.commit("app", "main", { "late.txt": "late\n" }, { at: 4000 });
        }
        return artifacts.fetch(input, init);
      },
    });

    await expect(merge(theirs, racing)).rejects.toMatchObject({ code: "conflict" });
    expect(artifacts.tip("app", "main")).toBe(raced);
  });

  it("gives up on a true merge that is too large for the Worker, having written nothing", async () => {
    await forked();
    const theirs = artifacts.commit(
      "app.fork.s1",
      "work",
      { "a.txt": "2\n" },
      { from: "main", at: 2000 },
    );
    const ours = artifacts.commit("app", "main", { "b.txt": "2\n" }, { at: 3000 });

    await expect(merge(theirs, writerWith({ maxMergeBytes: 200 }))).rejects.toBeInstanceOf(
      MergeTooLargeError,
    );
    expect(artifacts.tip("app", "main")).toBe(ours);
  });

  it("creates the target branch when it does not exist", async () => {
    await artifacts.create("empty");
    const tip = artifacts.commit("app", "main", { a: "1" });
    const result = await writer.merge({
      target: { repo: "empty", branch: "main" },
      source: { repo: "app", sha: tip },
      message: "Seed",
      author,
    });
    expect(result).toEqual({ status: "merged", sha: tip });
    expect(artifacts.tip("empty", "main")).toBe(tip);
  });

  it("fails for a commit the source does not have", async () => {
    await forked();
    await expect(merge("1".repeat(40))).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("trimPack", () => {
  it("drops the flush-pkt Artifacts appends, and only that", async () => {
    await artifacts.create("p");
    artifacts.commit("p", "main", { a: "1" });
    const repo = await artifacts.get("p");
    const token = await repo.createToken("read", 60);
    const tip = artifacts.tip("p", "main");
    const body = `0032want ${tip}\n00000009done\n`;
    const reply = new Uint8Array(
      await (
        await artifacts.fetch(`${artifacts.remote("p")}/git-upload-pack`, {
          method: "POST",
          headers: { authorization: `Bearer ${token.plaintext}` },
          body,
        })
      ).arrayBuffer(),
    );
    const start = reply.findIndex(
      (_, i) => new TextDecoder().decode(reply.subarray(i, i + 4)) === "PACK",
    );
    const withFlush = reply.subarray(start);
    expect(new TextDecoder().decode(withFlush.subarray(-4))).toBe("0000");
    const pack = await trimPack(withFlush);
    expect(pack?.byteLength).toBe(withFlush.byteLength - 4);
    expect(await trimPack(withFlush.subarray(0, -4))).toHaveLength(withFlush.byteLength - 4);
    expect(await trimPack(withFlush.subarray(0, -9))).toBeNull();
  });
});
