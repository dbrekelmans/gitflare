import { sectionContentHash } from "@gitflare/core";
import { createDemoPorts, FakeGit, ManualClock } from "@gitflare/testing";
import { demo, demoChanges } from "@gitflare/testing/demo";
import { describe, expect, it, vi } from "vitest";
import { createDiffs, diffCommits, diffStats, formatUnified, mergeBase } from "./index";

describe("against the demo fixture", () => {
  it("produces a diff whose section hashes match every demo section", async () => {
    const ports = createDemoPorts();
    const diffs = createDiffs({ git: ports.git });
    const change = demoChanges.review;
    const diff = await diffs.between(demo.git.repos.forks.review, change.baseSha, change.headSha);

    for (const section of demo.sections.filter((s) => s.changeId === change.id)) {
      expect(sectionContentHash(diff, section.files)).toBe(section.contentHash);
    }
  });

  it("finds the fork's base as the merge base of base and head", async () => {
    const ports = createDemoPorts();
    const diffs = createDiffs({ git: ports.git });
    const change = demoChanges.review;
    expect(await diffs.mergeBase(demo.git.repos.forks.review, change.headSha, change.baseSha)).toBe(
      change.baseSha,
    );
  });

  it("formats a unified diff for prompts", async () => {
    const ports = createDemoPorts();
    const diffs = createDiffs({ git: ports.git });
    const change = demoChanges.review;
    const diff = await diffs.between(demo.git.repos.forks.review, change.baseSha, change.headSha);
    expect(diffs.format(diff)).toContain("+++ b/src/invites/rate-limit.ts");
  });
});

describe("diffCommits", () => {
  it("never reads a tree whose id did not change", async () => {
    const clock = new ManualClock();
    const git = new FakeGit(clock);
    const repo = "example";
    void git.createRepo(repo);
    const base = git.push(repo, "main", {
      "untouched/a.txt": "a\n",
      "untouched/b.txt": "b\n",
      "changed.txt": "one\n",
    }).after;
    const head = git.push(repo, "main", { "changed.txt": "two\n" }).after;

    const readTree = vi.spyOn(git, "readTree");
    const diff = await diffCommits({ git }, repo, base, head);
    expect(diff.map((f) => f.path)).toEqual(["changed.txt"]);

    const baseCommit = await git.readCommit(repo, base);
    const headCommit = await git.readCommit(repo, head);
    const baseEntries = await git.readTree(repo, baseCommit?.treeSha ?? "");
    const untouchedTreeSha = baseEntries?.find((e) => e.name === "untouched")?.sha;
    expect(headCommit?.treeSha).not.toBe(baseCommit?.treeSha);
    expect(untouchedTreeSha).toBeDefined();

    const readShas = readTree.mock.calls.map(([, sha]) => sha);
    expect(readShas.filter((sha) => sha === untouchedTreeSha)).toEqual([]);
  });

  it("yields no hunks for a binary file", async () => {
    const clock = new ManualClock();
    const git = new FakeGit(clock);
    const repo = "example";
    void git.createRepo(repo);
    const before = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]);
    const after = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 9, 9, 9]);
    const base = git.push(repo, "main", [{ path: "image.png", content: before }]).after;
    const head = git.push(repo, "main", [{ path: "image.png", content: after }]).after;

    const diff = await diffCommits({ git }, repo, base, head);
    expect(diff).toHaveLength(1);
    expect(diff[0]?.binary).toBe(true);
    expect(diff[0]?.hunks).toEqual([]);
    expect(diff[0]?.insertions).toBe(0);
    expect(diff[0]?.deletions).toBe(0);
  });

  it("reports an oversized text file as binary without reading its diff", async () => {
    const clock = new ManualClock();
    const git = new FakeGit(clock);
    const repo = "example";
    void git.createRepo(repo);
    const base = git.push(repo, "main", { "big.txt": "x\n".repeat(10) }).after;
    const head = git.push(repo, "main", { "big.txt": "y\n".repeat(10) }).after;

    const diff = await diffCommits({ git }, repo, base, head, { maxFileBytes: 5 });
    expect(diff).toHaveLength(1);
    expect(diff[0]?.binary).toBe(true);
    expect(diff[0]?.hunks).toEqual([]);
  });

  it("detects an exact-content rename", async () => {
    const clock = new ManualClock();
    const git = new FakeGit(clock);
    const repo = "example";
    void git.createRepo(repo);
    const base = git.push(repo, "main", { "old/name.txt": "same content\n" }).after;
    const head = git.push(repo, "main", [
      { path: "old/name.txt", delete: true },
      { path: "new/name.txt", content: "same content\n" },
    ]).after;

    const diff = await diffCommits({ git }, repo, base, head);
    expect(diff).toHaveLength(1);
    expect(diff[0]).toMatchObject({
      path: "new/name.txt",
      oldPath: "old/name.txt",
      status: "renamed",
      binary: false,
      hunks: [],
    });
  });

  it("diffs an added and a deleted file as whole-file hunks", async () => {
    const clock = new ManualClock();
    const git = new FakeGit(clock);
    const repo = "example";
    void git.createRepo(repo);
    const base = git.push(repo, "main", { "gone.txt": "bye\n" }).after;
    const head = git.push(repo, "main", [
      { path: "gone.txt", delete: true },
      { path: "new.txt", content: "hi\n" },
    ]).after;

    const diff = await diffCommits({ git }, repo, base, head);
    const added = diff.find((f) => f.path === "new.txt");
    const deleted = diff.find((f) => f.path === "gone.txt");
    expect(added).toMatchObject({ status: "added", insertions: 1, deletions: 0 });
    expect(deleted).toMatchObject({ status: "deleted", insertions: 0, deletions: 1 });
  });

  it("returns no diff for two identical commits", async () => {
    const clock = new ManualClock();
    const git = new FakeGit(clock);
    const repo = "example";
    void git.createRepo(repo);
    const base = git.push(repo, "main", { "a.txt": "a\n" }).after;

    const readTree = vi.spyOn(git, "readTree");
    const diff = await diffCommits({ git }, repo, base, base);
    expect(diff).toEqual([]);
    expect(readTree).not.toHaveBeenCalled();
  });
});

describe("mergeBase", () => {
  it("finds the common ancestor across a true merge commit", async () => {
    const clock = new ManualClock();
    const git = new FakeGit(clock);
    const repo = "example";
    void git.createRepo(repo);
    const root = git.push(repo, "main", { "a.txt": "a\n" }).after;
    const ours = git.push(repo, "ours", { "b.txt": "b\n" }).after;
    const theirsBranch = git.push(repo, "theirs", { "c.txt": "c\n" }).after;
    const merge = await git.merge({
      target: { repo, branch: "main" },
      source: { repo, sha: theirsBranch },
      message: "merge",
      author: { name: "Test", email: "test@example.com" },
    });
    expect(merge.status).toBe("merged");

    expect(await mergeBase({ git }, repo, ours, theirsBranch)).toBe(root);
  });
});

describe("diffStats and formatUnified", () => {
  it("summarises file and line counts", async () => {
    const clock = new ManualClock();
    const git = new FakeGit(clock);
    const repo = "example";
    void git.createRepo(repo);
    const base = git.push(repo, "main", { "a.txt": "one\ntwo\n" }).after;
    const head = git.push(repo, "main", { "a.txt": "one\nthree\n" }).after;
    const diff = await diffCommits({ git }, repo, base, head);

    expect(diffStats(diff, 1)).toEqual({
      commits: 1,
      filesChanged: 1,
      insertions: 1,
      deletions: 1,
    });
    expect(formatUnified(diff)).toContain("@@");
  });
});
