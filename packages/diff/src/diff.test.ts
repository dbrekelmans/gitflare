import { sectionContentHash } from "@gitflare/core";
import { createDemoPorts, FakeGit, ManualClock } from "@gitflare/testing";
import { demo, demoChanges } from "@gitflare/testing/demo";
import { describe, expect, it, vi } from "vitest";
import { createDiffs, diffCommits, diffStats, formatUnified, mergeBase } from "./index";

describe("against the demo fixture", () => {
  it("produces a diff whose section hashes match every demo section", async () => {
    const ports = createDemoPorts();
    const diffs = createDiffs({ git: ports.git });

    // Covers every section in the fixture, not just the review change's four:
    // the merged change (#11) has one of its own, against its own fork.
    const byChange = [
      { repo: demo.git.repos.forks.merged, change: demoChanges.merged },
      { repo: demo.git.repos.forks.review, change: demoChanges.review },
    ];
    let checked = 0;
    for (const { repo, change } of byChange) {
      const diff = await diffs.between(repo, change.baseSha, change.headSha);
      for (const section of demo.sections.filter((s) => s.changeId === change.id)) {
        expect(sectionContentHash(diff, section.files)).toBe(section.contentHash);
        checked++;
      }
    }
    expect(checked).toBe(demo.sections.length);
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

  it("does not pair two unrelated empty files as a rename", async () => {
    const clock = new ManualClock();
    const git = new FakeGit(clock);
    const repo = "example";
    void git.createRepo(repo);
    const base = git.push(repo, "main", { "e1.txt": "" }).after;
    const head = git.push(repo, "main", [
      { path: "e1.txt", delete: true },
      { path: "e2.txt", content: "" },
    ]).after;

    const diff = await diffCommits({ git }, repo, base, head);
    expect(diff.map((f) => ({ path: f.path, status: f.status }))).toEqual(
      expect.arrayContaining([
        { path: "e1.txt", status: "deleted" },
        { path: "e2.txt", status: "added" },
      ]),
    );
    expect(diff.find((f) => f.status === "renamed")).toBeUndefined();
  });

  it("reads a renamed file's unchanged blob once, not twice", async () => {
    const clock = new ManualClock();
    const git = new FakeGit(clock);
    const repo = "example";
    void git.createRepo(repo);
    const base = git.push(repo, "main", { "old.txt": "kept content\n" }).after;
    const head = git.push(repo, "main", [
      { path: "old.txt", delete: true },
      { path: "new.txt", content: "kept content\n" },
    ]).after;

    const readBlob = vi.spyOn(git, "readBlob");
    const diff = await diffCommits({ git }, repo, base, head);
    expect(diff).toHaveLength(1);
    expect(diff[0]?.status).toBe("renamed");
    expect(readBlob).toHaveBeenCalledTimes(1);
  });

  it("rejects an unknown repository", async () => {
    const clock = new ManualClock();
    const git = new FakeGit(clock);
    await expect(diffCommits({ git }, "nope", "a", "b")).rejects.toMatchObject({
      name: "ForgeError",
      code: "not_found",
    });
  });

  it("rejects a repository that is still forking", async () => {
    const clock = new ManualClock();
    const git = new FakeGit(clock);
    git.holdCopies = true;
    void git.createRepo("source");
    const base = git.push("source", "main", { "a.txt": "a\n" }).after;
    await git.forkRepo("source", "fork");

    await expect(diffCommits({ git }, "fork", base, base)).rejects.toMatchObject({
      name: "ForgeError",
      code: "not_ready",
    });
  });

  it("rejects an unknown commit instead of treating it as an empty tree", async () => {
    const clock = new ManualClock();
    const git = new FakeGit(clock);
    const repo = "example";
    void git.createRepo(repo);
    const base = git.push(repo, "main", { "a.txt": "a\n", "b.txt": "b\n" }).after;

    await expect(diffCommits({ git }, repo, base, "sha_does_not_exist")).rejects.toMatchObject({
      name: "ForgeError",
      code: "not_found",
    });
  });

  it("rejects a tree the host cannot produce instead of reporting the subtree as added", async () => {
    const clock = new ManualClock();
    const git = new FakeGit(clock);
    const repo = "example";
    void git.createRepo(repo);
    const base = git.push(repo, "main", { "a.txt": "a\n" }).after;
    const head = git.push(repo, "main", { "dir/file.txt": "x\n" }).after;

    vi.spyOn(git, "readTree").mockResolvedValueOnce(null);
    await expect(diffCommits({ git }, repo, base, head)).rejects.toMatchObject({
      name: "ForgeError",
      code: "not_found",
    });
  });

  it("diffs a large file with scattered edits correctly, not as oversized", async () => {
    const clock = new ManualClock();
    const git = new FakeGit(clock);
    const repo = "example";
    void git.createRepo(repo);
    // 1,200 unique lines with edits near the start, middle and end: trimming
    // the common prefix/suffix still leaves well over the 1,000,000-cell
    // direct-table threshold, so this only passes with the linear-space path.
    const size = 1200;
    const content = (edits: Record<number, string>) =>
      `${Array.from({ length: size }, (_, i) => edits[i] ?? `line ${i}`).join("\n")}\n`;
    const base = git.push(repo, "main", { "big.txt": content({}) }).after;
    const head = git.push(repo, "main", {
      "big.txt": content({
        100: "edited near the start",
        600: "edited in the middle",
        1150: "edited near the end",
      }),
    }).after;

    const diff = await diffCommits({ git }, repo, base, head);
    expect(diff).toHaveLength(1);
    const file = diff[0];
    expect(file?.binary).toBe(false);
    expect(file?.insertions).toBe(3);
    expect(file?.deletions).toBe(3);
    // Three edits hundreds of lines apart, each with its own default 3-line
    // context window, cannot land in the same hunk.
    expect(file?.hunks.length).toBe(3);
  });

  it("gives a mid-file insertion with no context lines a real oldStart, not 0", async () => {
    const clock = new ManualClock();
    const git = new FakeGit(clock);
    const repo = "example";
    void git.createRepo(repo);
    const base = git.push(repo, "main", { "a.txt": "one\ntwo\nthree\n" }).after;
    const head = git.push(repo, "main", { "a.txt": "one\ntwo\ninserted\nthree\n" }).after;

    const diff = await diffCommits({ git }, repo, base, head, { contextLines: 0 });
    const hunk = diff[0]?.hunks[0];
    expect(hunk?.oldStart).toBe(2);
    expect(hunk?.oldLines).toBe(0);
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

  it("picks the newer fork point, not an older ancestor reached by a shorter path", async () => {
    // x forks from main at m0; b forks from main later, at m3; main then
    // advances ten more commits and merges x. The merge commit's x-side
    // parent reaches m0 in one hop, while its mainline-side parent only
    // reaches m3 after ten: m3 is still the correct (newer) common ancestor
    // with b, because m0 is itself an ancestor of m3, not a sibling of it.
    const clock = new ManualClock();
    const git = new FakeGit(clock);
    const repo = "example";
    const author = { name: "Test", email: "test@example.com" };
    void git.createRepo(repo);
    const m0 = git.push(repo, "main", { "a.txt": "0" }).after;
    const xTip = git.push(repo, "x", { "x.txt": "x" }, { author }).after;
    git.push(repo, "main", { "a.txt": "1" });
    git.push(repo, "main", { "a.txt": "2" });
    const m3 = git.push(repo, "main", { "a.txt": "3" }).after;
    const bTip = git.push(repo, "b", { "b.txt": "b" }, { author }).after;
    for (let i = 0; i < 10; i++) git.push(repo, "main", { "a.txt": `m${4 + i}` });
    const merge = await git.merge({
      target: { repo, branch: "main" },
      source: { repo, sha: xTip },
      message: "merge x",
      author,
    });
    if (merge.status !== "merged") throw new Error("expected a merge");
    expect(m0).not.toBe(m3);

    expect(await mergeBase({ git }, repo, bTip, merge.sha)).toBe(m3);
    expect(await mergeBase({ git }, repo, merge.sha, bTip)).toBe(m3);
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
