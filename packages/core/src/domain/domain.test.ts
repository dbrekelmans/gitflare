import { describe, expect, it } from "vitest";
import { StartSessionInput } from "../api/inputs";
import { checkStartOptions, type SandboxStartOptions } from "../ports/sandbox";
import { captureState, parseCheckpointTrailers } from "./capture";
import { CiConfig } from "./ci";
import { decisionApplies, decisionWording, sameWording } from "./decision";
import { WorkspaceSettings } from "./organisation";
import { can } from "./permissions";
import { ArtifactsPushEvent, classifyPush, parseCheckpointRef, toPush, ZERO_SHA } from "./push";
import { contextRepoName, forkRepoName, mainRepoName, parseRepoName } from "./repo-names";
import type { DiffLine, FileDiff } from "./section";
import { hunkHash, sectionContentHash, sectionStats, selectDiff } from "./section-hash";

const sha = "def789a012def789a012def789a012def789a012";

describe("repository names", () => {
  it("round-trips the three kinds", () => {
    expect(parseRepoName(mainRepoName("atlas-web"))).toEqual({ kind: "main", slug: "atlas-web" });
    expect(parseRepoName(contextRepoName("atlas-web"))).toEqual({
      kind: "context",
      slug: "atlas-web",
    });
    expect(parseRepoName(forkRepoName("atlas-web", "ses_01k6abc"))).toEqual({
      kind: "fork",
      slug: "atlas-web",
      sessionId: "ses_01k6abc",
    });
  });

  it("rejects names gitflare did not make", () => {
    expect(parseRepoName("atlas-web.other")).toBeNull();
    expect(parseRepoName("atlas-web.fork.")).toBeNull();
    expect(parseRepoName(".context")).toBeNull();
    expect(parseRepoName("")).toBeNull();
  });
});

describe("pushes", () => {
  it("parses the documented event and ignores what it does not know", () => {
    const event = ArtifactsPushEvent.parse({
      type: "cf.artifacts.repo.pushed",
      source: { type: "artifacts.repo", namespace: "ns", repoName: "atlas-web.fork.01k6abc" },
      payload: { ref: "refs/heads/rate-limit", before: ZERO_SHA, after: sha, commits: [] },
      metadata: { eventSchemaVersion: 1 },
    });
    expect(classifyPush(toPush(event))).toEqual({
      kind: "change",
      slug: "atlas-web",
      sessionId: "ses_01k6abc",
      branch: "rate-limit",
    });
  });

  it("recognises checkpoint refs by shape", () => {
    const id = "01M3WE2VX9HQC3NVY9BWYCW6JV";
    expect(parseCheckpointRef(`refs/entire/checkpoints/JV/${id}`)).toBe(id);
    expect(parseCheckpointRef(`refs/entire/checkpoints/XX/${id}`)).toBeNull();
    expect(parseCheckpointRef("refs/entire/checkpoints/v2/main")).toBeNull();
    expect(parseCheckpointRef("refs/entire/checkpoints/c4/a3b2c4d5e6c4")).toBe("a3b2c4d5e6c4");
    const push = { repoName: "atlas-web.context", before: ZERO_SHA, after: sha };
    expect(classifyPush({ ...push, ref: `refs/entire/checkpoints/JV/${id}` })).toEqual({
      kind: "checkpoint",
      slug: "atlas-web",
      checkpointId: id,
    });
    expect(classifyPush({ ...push, ref: "refs/heads/entire/checkpoints/v1" }).kind).toBe("ignored");
    expect(classifyPush({ ...push, ref: "refs/heads/main" }).kind).toBe("ignored");
  });

  it("ignores deletions, the main repo, tags and capture branches", () => {
    const fork = { repoName: "atlas-web.fork.01k6abc", before: sha, after: sha };
    expect(classifyPush({ ...fork, ref: "refs/heads/x", after: ZERO_SHA }).kind).toBe("ignored");
    expect(classifyPush({ ...fork, ref: "refs/tags/v1" }).kind).toBe("ignored");
    expect(classifyPush({ ...fork, ref: "refs/heads/entire/a02a31f-821774" }).kind).toBe("ignored");
    expect(classifyPush({ ...fork, repoName: "atlas-web", ref: "refs/heads/main" }).kind).toBe(
      "ignored",
    );
  });
});

describe("permissions", () => {
  const admin = { id: "usr_admin", role: "admin" } as const;
  const member = { id: "usr_member", role: "member" } as const;

  it("keeps administration to administrators", () => {
    expect(can(admin, { type: "members.manage" })).toBe(true);
    expect(can(member, { type: "members.manage" })).toBe(false);
    expect(can(member, { type: "repository.create" })).toBe(false);
    expect(can(member, { type: "change.merge" })).toBe(true);
  });

  it("gives a session's write access to its owner only, while it is active", () => {
    const session = { userId: "usr_member", status: "active" } as const;
    expect(can(member, { type: "session.write", session })).toBe(true);
    expect(can(admin, { type: "session.write", session })).toBe(false);
    expect(can(admin, { type: "session.abandon", session })).toBe(true);
    expect(can(member, { type: "session.write", session: { ...session, status: "merged" } })).toBe(
      false,
    );
  });
});

describe("schemas", () => {
  it("fills CI defaults", () => {
    const config = CiConfig.parse({ steps: [{ name: "test", run: "pnpm test" }] });
    expect(config.instance).toBe("standard-2");
    expect(config.egress).toEqual({ hosts: [] });
    expect(config.steps[0]).toEqual({
      name: "test",
      run: "pnpm test",
      needs: [],
      timeoutMinutes: 15,
    });
  });

  it("lets a CI file name the hosts it fetches from, but never every host", () => {
    const steps = [{ name: "test", run: "pytest" }];
    const hosts = ["pypi.org", "*.pythonhosted.org"];
    expect(CiConfig.parse({ steps, egress: { hosts } }).egress.hosts).toEqual(hosts);
    for (const host of ["*", "*.*", "https://pypi.org", "pypi.org/simple", ""]) {
      expect(CiConfig.safeParse({ steps, egress: { hosts: [host] } }).success, host).toBe(false);
    }
  });

  it("reads workspace settings stored before preparation was recorded", () => {
    const stored = { image: "base", snapshot: null };
    expect(WorkspaceSettings.parse(stored)).toEqual(stored);
    const failed = { state: "failed", failedAt: 5, error: "setup.sh exited 1" };
    expect(WorkspaceSettings.parse({ ...stored, preparation: failed }).preparation).toEqual(failed);
  });

  it("requires a prompt for a cloud session only", () => {
    const base = { repoSlug: "atlas-web", title: "Rate limit invites" };
    expect(StartSessionInput.safeParse({ ...base, kind: "local" }).success).toBe(true);
    expect(StartSessionInput.safeParse({ ...base, kind: "cloud" }).success).toBe(false);
    expect(StartSessionInput.safeParse({ ...base, kind: "cloud", prompt: "do it" }).success).toBe(
      true,
    );
  });
});

describe("section hashes", () => {
  const line = (kind: DiffLine["kind"], text: string, n: number): DiffLine => ({
    kind,
    text,
    oldLine: kind === "add" ? null : n,
    newLine: kind === "delete" ? null : n,
  });
  const file = (path: string, lines: DiffLine[]): FileDiff => ({
    path,
    oldPath: null,
    status: "modified",
    binary: false,
    insertions: 1,
    deletions: 0,
    hunks: [
      { oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines, hash: hunkHash(path, lines) },
    ],
  });

  it("keeps a hunk's hash when it only moves or its context changes", () => {
    const original = [line("context", "a", 1), line("add", "b", 2)];
    const moved = [line("context", "z", 40), line("add", "b", 41)];
    expect(hunkHash("f.ts", moved)).toBe(hunkHash("f.ts", original));
    expect(hunkHash("f.ts", [line("add", "c", 2)])).not.toBe(hunkHash("f.ts", original));
    expect(hunkHash("g.ts", original)).not.toBe(hunkHash("f.ts", original));
    expect(hunkHash("f.ts", [line("delete", "b", 2)])).not.toBe(hunkHash("f.ts", original));
  });

  it("changes a section's hash only when a file it presents changes", () => {
    const a = file("a.ts", [line("add", "one", 1)]);
    const b = file("b.ts", [line("add", "two", 1)]);
    const section = [{ path: "a.ts", hunkHashes: [] }];
    const before = sectionContentHash([a, b], section);
    expect(sectionContentHash([a, file("b.ts", [line("add", "changed", 1)])], section)).toBe(
      before,
    );
    expect(sectionContentHash([file("a.ts", [line("add", "changed", 1)]), b], section)).not.toBe(
      before,
    );
    expect(sectionContentHash([{ ...a, status: "added" }, b], section)).not.toBe(before);
    expect(sectionContentHash([b], section)).not.toBe(before);
  });

  it("does not move a section's hash when its files are listed in another order", () => {
    const a = file("a.ts", [line("add", "one", 1)]);
    const b = file("b.ts", [line("add", "two", 1)]);
    const listed = [
      { path: "a.ts", hunkHashes: [] },
      { path: "b.ts", hunkHashes: [] },
    ];
    expect(sectionContentHash([a, b], [...listed].reverse())).toBe(
      sectionContentHash([a, b], listed),
    );
    expect(selectDiff([a, b], [...listed].reverse())).toEqual([b, a]);
  });

  it("sizes a section by the hunks it presents", () => {
    const first = [line("add", "one", 1), line("context", "x", 2)];
    const second = [line("delete", "two", 9), line("add", "three", 9)];
    const a: FileDiff = {
      ...file("a.ts", first),
      hunks: [
        { oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: first, hash: "h1" },
        { oldStart: 9, oldLines: 1, newStart: 10, newLines: 1, lines: second, hash: "h2" },
      ],
    };
    expect(sectionStats([a], [{ path: "a.ts", hunkHashes: [] }])).toEqual({
      filesChanged: 1,
      insertions: 2,
      deletions: 1,
    });
    expect(sectionStats([a], [{ path: "a.ts", hunkHashes: ["h1"] }])).toEqual({
      filesChanged: 1,
      insertions: 1,
      deletions: 0,
    });
    expect(sectionStats([a], [{ path: "gone.ts", hunkHashes: [] }])).toEqual({
      filesChanged: 0,
      insertions: 0,
      deletions: 0,
    });
  });

  it("selects whole files or named hunks", () => {
    const a = file("a.ts", [line("add", "one", 1)]);
    expect(selectDiff([a], [{ path: "a.ts", hunkHashes: [] }])).toEqual([a]);
    expect(selectDiff([a], [{ path: "a.ts", hunkHashes: ["nope"] }])).toEqual([]);
    expect(selectDiff([a], [{ path: "a.ts", hunkHashes: [a.hunks[0]?.hash ?? ""] }])).toEqual([a]);
  });
});

describe("decisions", () => {
  it("compares the whole wording", () => {
    const wording = { title: "T", statement: "S", rationale: "R" };
    expect(decisionWording({ ...wording, id: "dec_1" } as never)).toEqual(wording);
    expect(sameWording(wording, { ...wording })).toBe(true);
    for (const key of ["title", "statement", "rationale"] as const) {
      expect(sameWording(wording, { ...wording, [key]: "changed" }), key).toBe(false);
    }
  });

  it("applies a general rule everywhere and a path rule where a glob matches", () => {
    const paths = (...globs: string[]) => ({ kind: "paths", globs }) as const;
    expect(decisionApplies({ kind: "general" }, [])).toBe(true);
    expect(decisionApplies(paths("src/billing/**"), ["src/billing/a/b.ts"])).toBe(true);
    expect(decisionApplies(paths("src/billing/"), ["src/billing/a.ts"])).toBe(true);
    expect(decisionApplies(paths("src/billing/**"), ["src/billing.ts", "docs/x.md"])).toBe(false);
    expect(decisionApplies(paths("src/*.ts"), ["src/a.ts"])).toBe(true);
    expect(decisionApplies(paths("src/*.ts"), ["src/a/b.ts"])).toBe(false);
    expect(decisionApplies(paths("src/**/*.test.ts"), ["src/a.test.ts", "x"])).toBe(true);
    expect(decisionApplies(paths("**/*.sql"), ["migrations/0001.sql"])).toBe(true);
    expect(decisionApplies(paths("a.b"), ["axb"])).toBe(false);
    expect(decisionApplies(paths("docs/**", "src/x.ts"), ["src/x.ts"])).toBe(true);
    expect(decisionApplies(paths("src/**"), [])).toBe(false);
  });
});

describe("sandbox start options", () => {
  const base: SandboxStartOptions = { image: "base", instance: "lite", egress: [] };
  const invalid = (options: SandboxStartOptions) => {
    try {
      checkStartOptions(options);
    } catch (error) {
      return (error as { code?: string }).code;
    }
    return null;
  };

  it("accepts named hosts, globs within a name, and open Internet on its own", () => {
    expect(invalid(base)).toBeNull();
    expect(invalid({ ...base, egress: [{ kind: "host", host: "*.npmjs.org" }] })).toBeNull();
    expect(invalid({ ...base, openInternet: true })).toBeNull();
  });

  it("refuses a host grant of * and open Internet combined with any grant", () => {
    expect(invalid({ ...base, egress: [{ kind: "host", host: "*" }] })).toBe("invalid");
    expect(
      invalid({ ...base, openInternet: true, egress: [{ kind: "host", host: "pypi.org" }] }),
    ).toBe("invalid");
    expect(
      invalid({
        ...base,
        openInternet: true,
        egress: [{ kind: "git", repo: "atlas-web", scope: "read" }],
      }),
    ).toBe("invalid");
  });
});

describe("capture", () => {
  const ulid = "01M3WE2VX9HQC3NVY9BWYCW6JV";

  it("collects every checkpoint trailer once, in order, in both id shapes", () => {
    const message = [
      "Squash two commits",
      "",
      "Co-Authored-By: Someone <s@example.com>",
      `Entire-Checkpoint: ${ulid}`,
      "Entire-Checkpoint: a3b2c4d5e6f7",
      `Entire-Checkpoint: ${ulid}`,
    ].join("\n");
    expect(parseCheckpointTrailers(message)).toEqual([ulid, "a3b2c4d5e6f7"]);
    expect(parseCheckpointTrailers("No trailers here")).toEqual([]);
    expect(parseCheckpointTrailers("Entire-Checkpoint: not-an-id")).toEqual([]);
    expect(parseCheckpointTrailers(`Entire-Checkpoint: ${ulid}extra`)).toEqual([]);
  });

  it("tells present, pending, missing and none apart", () => {
    expect(captureState({ named: [], arrived: [], waiting: true })).toBe("none");
    expect(captureState({ named: ["a"], arrived: ["a", "b"], waiting: false })).toBe("present");
    expect(captureState({ named: ["a", "b"], arrived: ["a"], waiting: true })).toBe("pending");
    expect(captureState({ named: ["a", "b"], arrived: ["a"], waiting: false })).toBe("missing");
  });
});
