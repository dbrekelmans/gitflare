import { type Decision, ForgeError } from "@gitflare/core";
import { demo } from "@gitflare/testing/demo";
import { describe, expect, it } from "vitest";
import { parseDecisionFile, renderDecisionFile } from "./file";

function roundTrip(decision: Decision): Decision {
  return {
    ...parseDecisionFile(decision.path, renderDecisionFile(decision)),
    repositoryId: decision.repositoryId,
  };
}

const awkward: Decision = {
  id: "dec_01k6awkward",
  repositoryId: "rep_x",
  path: "decisions/quotes-colons-and-hashes.md",
  title: 'Quotes: "colons", #hashes & --- dashes',
  statement: [
    "# This line looks like a title",
    "",
    "A second paragraph, with a list:",
    "- one",
    "- two",
    "",
    "## Rationale",
    "\\## Rationale",
    "---",
    "status: dormant",
  ].join("\n"),
  rationale: "First reason.\n\n## Rationale\n\nA heading of the same name inside the rationale.",
  scope: { kind: "paths", globs: ["src/**/*.ts", "*.md: odd, glob"] },
  status: "active",
  strength: 0.5750000000000001,
  origin: "review_reply",
  originChangeId: "chg_01k6change",
  originThreadId: "thr_01k6thread",
  createdAt: Date.UTC(2026, 8, 17, 9, 0, 0, 123),
  updatedAt: Date.UTC(2026, 9, 2, 23, 59, 59, 999),
};

describe("the decision file", () => {
  it.each(demo.decisions)("round-trips the demo's $id", (decision) => {
    expect(roundTrip(decision)).toEqual(decision);
  });

  it("round-trips text that looks like the file's own structure", () => {
    expect(roundTrip(awkward)).toEqual(awkward);
  });

  it("round-trips a decision with no rationale, and one with an empty list of paths", () => {
    const bare: Decision = {
      ...awkward,
      rationale: "",
      scope: { kind: "paths", globs: [] },
      originChangeId: null,
      originThreadId: null,
    };
    expect(roundTrip(bare)).toEqual(bare);
    expect(renderDecisionFile(bare)).not.toContain("## Rationale\n\n");
  });

  it("is what a person would expect to read", () => {
    const [first] = demo.decisions;
    if (!first) throw new Error("the demo has no decisions");
    const text = renderDecisionFile(first);
    expect(text.startsWith(`---\nid: ${first.id}\nstatus: active\nstrength: 0.5\n`)).toBe(true);
    expect(text).toContain(`\n---\n\n# ${first.title}\n\n${first.statement}\n\n## Rationale\n\n`);
    expect(text.endsWith(`${first.rationale}\n`)).toBe(true);
  });

  it("reads what a person changed in the body", () => {
    const [first] = demo.decisions;
    if (!first) throw new Error("the demo has no decisions");
    const edited = renderDecisionFile(first)
      .replace(first.title, "Sliding windows everywhere")
      .replace(first.statement, "Every limit uses a sliding window.\r\nNo exceptions.");
    const parsed = parseDecisionFile(first.path, edited);
    expect(parsed.title).toBe("Sliding windows everywhere");
    expect(parsed.statement).toBe("Every limit uses a sliding window.\nNo exceptions.");
    expect(parsed.rationale).toBe(first.rationale);
  });

  it.each([
    ["no front matter", "# A title\n\nA statement.\n"],
    ["a bad id", "---\nid: nope\n---\n\n# A title\n\nA statement.\n"],
    ["a strength out of range", renderDecisionFile(awkward).replace(/strength: .*/, "strength: 3")],
    ["no title", renderDecisionFile({ ...awkward, statement: "x" }).replace(/\n# .*\n/, "\n")],
    ["no statement", renderDecisionFile({ ...awkward, statement: "x" }).replace("\nx\n", "\n")],
    ["broken YAML", renderDecisionFile(awkward).replace("status: active", "status: [")],
  ])("refuses a file with %s, naming it", (_what, text) => {
    const parse = () => parseDecisionFile("decisions/broken.md", text);
    expect(parse).toThrow(ForgeError);
    expect(parse).toThrow(/^decisions\/broken\.md: /);
  });
});
