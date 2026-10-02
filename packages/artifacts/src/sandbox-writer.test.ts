import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GitWriter } from "@gitflare/core/ports";
import { FakeSandboxHost, type RecordedCommand, SequentialIds } from "@gitflare/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createArtifactsGitHost } from "./host";
import { createSandboxGitWriter } from "./sandbox-writer";
import { LocalArtifacts } from "./testing/local-artifacts";
import { createWorkerGitWriter } from "./worker-writer";

// These tests run real git; a slow machine needs more than the default five seconds.
vi.setConfig({ testTimeout: 30_000 });

const author = { name: "gitflare", email: "gitflare@example.test" };
const prepared = { image: "base", snapshot: { id: "snap_1", image: "base" } };

let artifacts: LocalArtifacts;
let sandboxes: FakeSandboxHost;
let scratch: string;
/** Runs before each command the sandbox is given. */
let before: (command: RecordedCommand) => void;

/**
 * The sandbox, played by this machine: every command is run for real, with
 * the remotes pointed at the stub's repositories on disk. What is tested is
 * therefore the git recipe itself, not a script of its expected output.
 */
function runLocally(command: RecordedCommand) {
  before(command);
  const local = (text: string) =>
    text
      .replace("/tmp/gitflare-merge", scratch)
      .replace(/https:\/\/artifacts\.test\/git\/[^/]+\/(.+)\.git$/, (_, name) =>
        artifacts.path(name),
      );
  const [program = "", ...args] = command.command.map(local);
  const result = spawnSync(program, args, {
    cwd: command.options.cwd ? local(command.options.cwd) : undefined,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      ...command.options.env,
    },
  });
  return { exitCode: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
}

function writerWith(options: {
  tooLargeForWorker: boolean;
  workspace?: typeof prepared;
}): GitWriter {
  const git = createArtifactsGitHost(artifacts);
  return createSandboxGitWriter({
    git,
    sandboxes,
    ids: new SequentialIds(),
    workspace: async () => options.workspace ?? prepared,
    worker: createWorkerGitWriter({
      git,
      fetch: artifacts.fetch,
      maxMergeBytes: options.tooLargeForWorker ? 100 : undefined,
    }),
  });
}

/** A main repo and a fork whose branch and main have both moved since. */
async function diverged(theirs: Record<string, string>, ours: Record<string, string>) {
  await artifacts.create("app");
  artifacts.commit("app", "main", { "a.txt": "1\n", "b.txt": "1\n" }, { at: 1000 });
  await (await artifacts.get("app")).fork("app.fork.s1");
  artifacts.commit("app.fork.s1", "work", { "c.txt": "1\n" }, { from: "main", at: 2000 });
  const theirTip = artifacts.commit("app.fork.s1", "work", theirs, { at: 2100 });
  const ourTip = artifacts.commit("app", "main", ours, { at: 3000 });
  return { theirTip, ourTip };
}

const request = (sha: string) => ({
  target: { repo: "app", branch: "main" },
  source: { repo: "app.fork.s1", sha },
  message: "Merge change #7",
  author,
});

beforeEach(() => {
  artifacts = new LocalArtifacts();
  scratch = join(mkdtempSync(join(tmpdir(), "gitflare-sandbox-")), "merge");
  before = () => {};
  sandboxes = new FakeSandboxHost().on(runLocally);
});
afterEach(() => {
  artifacts.cleanup();
  rmSync(join(scratch, ".."), { recursive: true, force: true });
});

describe("createSandboxGitWriter", () => {
  it("merges in a sandbox what the Worker gave up on", async () => {
    const { theirTip, ourTip } = await diverged({ "a.txt": "2\n" }, { "b.txt": "2\n" });
    const result = await writerWith({ tooLargeForWorker: true }).merge(request(theirTip));

    expect(result.status).toBe("merged");
    const sha = result.status === "merged" ? result.sha : "";
    expect(artifacts.tip("app", "main")).toBe(sha);
    expect(artifacts.git("app", "log", "-1", "--format=%P%n%s%n%an <%ae>", sha)).toBe(
      `${ourTip} ${theirTip}\nMerge change #7\ngitflare <gitflare@example.test>`,
    );
    expect(artifacts.git("app", "show", "main:a.txt")).toBe("2");
    expect(artifacts.git("app", "show", "main:b.txt")).toBe("2");
    expect(artifacts.git("app", "show", "main:c.txt")).toBe("1");
    artifacts.git("app", "fsck", "--strict");

    // It booted the prepared workspace, with git egress to the two
    // repositories and nothing else, and did not leave it running.
    expect(sandboxes.startOptions("sbx_000001")).toEqual({
      image: "base",
      snapshot: prepared.snapshot,
      instance: "standard-1",
      egress: [
        { kind: "git", repo: "app", scope: "write" },
        { kind: "git", repo: "app.fork.s1", scope: "read" },
      ],
    });
    expect(await sandboxes.get("sbx_000001").isRunning()).toBe(false);
    // Each side is fetched only as deep as the commit the histories parted at.
    const fetches = sandboxes.commands
      .filter((command) => command.command[1] === "fetch")
      .map((command) => command.command[3]);
    expect(fetches).toEqual(["--depth=2", "--depth=3"]);
  });

  it("reports the conflicting paths and pushes nothing", async () => {
    const { theirTip, ourTip } = await diverged(
      { "a.txt": "theirs\n", "b.txt": "theirs\n" },
      { "a.txt": "ours\n", "b.txt": "ours\n" },
    );
    const result = await writerWith({ tooLargeForWorker: true }).merge(request(theirTip));

    expect(result).toEqual({ status: "conflict", paths: ["a.txt", "b.txt"] });
    expect(artifacts.tip("app", "main")).toBe(ourTip);
    expect(sandboxes.commands.some((command) => command.command[1] === "push")).toBe(false);
    expect(await sandboxes.get("sbx_000001").isRunning()).toBe(false);
  });

  it("is a conflict when the branch moves while the sandbox merges", async () => {
    const { theirTip } = await diverged({ "a.txt": "2\n" }, { "b.txt": "2\n" });
    let raced = "";
    before = (command) => {
      if (command.command[1] === "commit-tree") {
        raced = artifacts.commit("app", "main", { "d.txt": "late\n" }, { at: 4000 });
      }
    };
    await expect(
      writerWith({ tooLargeForWorker: true }).merge(request(theirTip)),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(artifacts.tip("app", "main")).toBe(raced);
    expect(await sandboxes.get("sbx_000001").isRunning()).toBe(false);
  });

  it("starts no sandbox for what the Worker can do itself", async () => {
    const { theirTip } = await diverged({ "a.txt": "2\n" }, { "b.txt": "2\n" });
    const writer = writerWith({ tooLargeForWorker: false });

    expect((await writer.merge(request(theirTip))).status).toBe("merged");
    const tip = artifacts.tip("app", "main") ?? "";
    const { sha } = await writer.commitFiles({
      repo: "app",
      branch: "main",
      expectedParent: tip,
      changes: [{ path: "e.txt", content: "e\n" }],
      message: "Add e",
      author,
    });
    expect(artifacts.tip("app", "main")).toBe(sha);
    expect(sandboxes.commands).toEqual([]);
  });

  it("says the workspace is not prepared instead of booting an image without git", async () => {
    const { theirTip, ourTip } = await diverged({ "a.txt": "2\n" }, { "b.txt": "2\n" });
    const writer = writerWith({
      tooLargeForWorker: true,
      workspace: { image: "base", snapshot: null as never },
    });
    await expect(writer.merge(request(theirTip))).rejects.toMatchObject({ code: "unavailable" });
    expect(sandboxes.startOptions("sbx_000001")).toBeNull();
    expect(artifacts.tip("app", "main")).toBe(ourTip);
  });
});
