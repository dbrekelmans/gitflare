import { type FileDiff, type Section, sectionContentHash } from "@gitflare/core";
import { diffFiles } from "@gitflare/testing";
import { demoFiles } from "@gitflare/testing/demo";
import { describe, expect, it } from "vitest";
import { foldRevision } from "./fold";
import { review } from "./testing/demo";

function section(id: string, position: number, files: Section["files"], diff: FileDiff[]): Section {
  return {
    id: `sec_${id}`,
    changeId: "chg_test",
    position,
    title: id,
    kind: "behaviour",
    explanation: `What ${id} does.`,
    files,
    contentHash: sectionContentHash(diff, files),
    createdRevisionId: "rev_1",
    updatedRevisionId: "rev_1",
  };
}

const whole = (...paths: string[]) => paths.map((path) => ({ path, hunkHashes: [] }));

describe("foldRevision on the demo's two revisions", () => {
  const firstDiff = diffFiles(demoFiles.base, demoFiles.rev1);
  const secondDiff = diffFiles(demoFiles.base, demoFiles.head);
  // The fixture holds the sections as they are after the second push; this is them after the first.
  const afterFirstPush = review.sections.map((s) => ({
    ...s,
    contentHash: sectionContentHash(firstDiff, s.files),
    updatedRevisionId: s.createdRevisionId,
  }));

  it("leaves two sections' hashes unchanged and moves two", () => {
    const { sections, unplaced } = foldRevision(afterFirstPush, secondDiff);

    const moved = sections.filter(
      (s, index) => s.contentHash !== afterFirstPush[index]?.contentHash,
    );
    expect(moved.map((s) => s.id)).toEqual(["sec_demo12limit", "sec_demo12tests"]);
    expect(sections.map((s) => s.contentHash)).toEqual(review.sections.map((s) => s.contentHash));
    expect(unplaced).toEqual([]);
  });

  it("returns the untouched sections as they were given", () => {
    const { sections } = foldRevision(afterFirstPush, secondDiff);

    expect(sections[1]).toBe(afterFirstPush[1]);
    expect(sections[3]).toBe(afterFirstPush[3]);
    // A moved section changes in its hash and in nothing else.
    expect({ ...sections[0], contentHash: "" }).toEqual({ ...afterFirstPush[0], contentHash: "" });
  });

  it("changes nothing when the same diff is folded in again", () => {
    const once = foldRevision(afterFirstPush, secondDiff);
    const twice = foldRevision(once.sections, secondDiff);

    twice.sections.forEach((s, index) => {
      expect(s).toBe(once.sections[index]);
    });
    expect(twice.unplaced).toEqual([]);
  });
});

describe("foldRevision", () => {
  const base = { "a.ts": "one\n", "b.ts": "two\n" };
  const first = diffFiles(base, { "a.ts": "one!\n", "b.ts": "two!\n" });
  const a = section("a", 0, whole("a.ts"), first);
  const b = section("b", 1, whole("b.ts"), first);

  it("returns a file no section presents as unplaced, and touches no section for it", () => {
    const diff = diffFiles(base, { "a.ts": "one!\n", "b.ts": "two!\n", "c.ts": "three\n" });

    const { sections, unplaced } = foldRevision([a, b], diff);

    expect(unplaced.map((file) => file.path)).toEqual(["c.ts"]);
    expect(sections[0]).toBe(a);
    expect(sections[1]).toBe(b);
  });

  it("drops a section left with nothing to show", () => {
    const diff = diffFiles(base, { "a.ts": "one!\n", "b.ts": "two\n" });

    const { sections, unplaced } = foldRevision([a, b], diff);

    expect(sections).toEqual([a]);
    expect(unplaced).toEqual([]);
  });

  it("moves a section's hash when one of its files is deleted instead of edited", () => {
    const diff = diffFiles(base, { "a.ts": "one!\n" });

    const { sections } = foldRevision([a, b], diff);

    expect(sections[0]).toBe(a);
    expect(sections[1]?.id).toBe(b.id);
    expect(sections[1]?.contentHash).not.toBe(b.contentHash);
  });

  it("returns the sections in reading order", () => {
    expect(foldRevision([b, a], first).sections).toEqual([a, b]);
  });

  describe("with a file divided between two sections by hunk", () => {
    const lines = Array.from({ length: 40 }, (_, index) => `line ${index + 1}`);
    const edit = (changes: Record<number, string>, prefix: string[] = []) =>
      `${[...prefix, ...lines.map((line, index) => changes[index + 1] ?? line)].join("\n")}\n`;
    const before = { "big.ts": edit({}) };
    const split = diffFiles(before, { "big.ts": edit({ 12: "top", 32: "bottom" }) });
    const [top, bottom] = split[0]?.hunks ?? [];
    const upper = section("upper", 0, [{ path: "big.ts", hunkHashes: [top?.hash ?? ""] }], split);
    const lower = section(
      "lower",
      1,
      [{ path: "big.ts", hunkHashes: [bottom?.hash ?? ""] }],
      split,
    );

    it("has two hunks to divide", () => {
      expect(split[0]?.hunks).toHaveLength(2);
    });

    it("keeps both hashes when another part of the file changes, and returns that part unplaced", () => {
      const diff = diffFiles(before, { "big.ts": edit({ 12: "top", 22: "middle", 32: "bottom" }) });

      const { sections, unplaced } = foldRevision([upper, lower], diff);

      expect(sections[0]).toBe(upper);
      expect(sections[1]).toBe(lower);
      expect(unplaced).toHaveLength(1);
      expect(
        unplaced[0]?.hunks.map((hunk) => hunk.lines.find((l) => l.kind === "add")?.text),
      ).toEqual(["middle"]);
    });

    it("keeps both hashes when their hunks only move down the file", () => {
      const diff = diffFiles(before, {
        "big.ts": edit({ 12: "top", 32: "bottom" }, ["new first line"]),
      });

      const { sections, unplaced } = foldRevision([upper, lower], diff);

      expect(sections[0]).toBe(upper);
      expect(sections[1]).toBe(lower);
      expect(unplaced.flatMap((file) => file.hunks)).toHaveLength(1);
    });

    it("moves only the section whose hunk was edited", () => {
      const diff = diffFiles(before, { "big.ts": edit({ 12: "top", 32: "bottom, again" }) });
      const other = first.filter((file) => file.path === "b.ts");
      const both = section(
        "both",
        1,
        [{ path: "big.ts", hunkHashes: [bottom?.hash ?? ""] }, ...whole("b.ts")],
        [...split, ...other],
      );

      const { sections, unplaced } = foldRevision([upper, both], [...diff, ...other]);

      expect(sections[0]).toBe(upper);
      expect(sections[1]?.contentHash).not.toBe(both.contentHash);
      // The edited hunk is a hunk no section names any more.
      expect(unplaced.map((file) => file.path)).toEqual(["big.ts"]);
    });
  });
});
