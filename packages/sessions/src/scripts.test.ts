import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseAgentEvents } from "./events";
import { CHECKOUT_SCRIPT, scripts, TURN_SCRIPT } from "./scripts";

function installed(tool: string): boolean {
  return spawnSync(tool, ["--version"], { stdio: "ignore" }).status === 0;
}

// The scripts run for real here, against a repository on this machine: the
// fake sandbox runs nothing, and a sandbox is the only other place they run.
const runnable = ["git", "bash", "jq"].every(installed);
const shellcheckInstalled = installed("shellcheck");
// coreutils' `timeout`, which the workspace image has and macOS does not.
const timeoutInstalled = installed("timeout");

describe("tools", () => {
  // GitHub's runners ship all five. A developer's machine may not: there the
  // tests below are skipped, but CI must never pass because a tool went missing.
  it("are present in CI", () => {
    if (process.env.CI)
      expect({ runnable, shellcheckInstalled, timeoutInstalled }).toEqual({
        runnable: true,
        shellcheckInstalled: true,
        timeoutInstalled: true,
      });
  });
});

describe.skipIf(!shellcheckInstalled)("shellcheck", () => {
  it.each(Object.entries(scripts))("passes the %s script", (_name, { shell, text }) => {
    const result = spawnSync("shellcheck", [`--shell=${shell}`, "--severity=style", "-"], {
      input: `${text}\n`,
      encoding: "utf8",
    });
    expect(result.stdout).toBe("");
  });
});

describe.skipIf(!runnable)("in a real checkout", () => {
  let root: string;
  let remote: string;
  let checkout: string;
  let env: NodeJS.ProcessEnv;

  function git(cwd: string, ...args: string[]): string {
    return execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();
  }

  function runCheckout(branch: string) {
    return spawnSync(
      "sh",
      ["-c", CHECKOUT_SCRIPT, "gitflare-checkout", remote, checkout, branch, "Maya", "maya@x.test"],
      { env, encoding: "utf8" },
    );
  }

  /** Runs one turn whose "agent" is a shell script, and returns the turn's stream and exit code. */
  function runTurn(branch: string, agent: string, limitSeconds = 60) {
    const result = spawnSync(
      "bash",
      ["-c", TURN_SCRIPT, "gitflare-turn", branch, String(limitSeconds), "sh", "-c", agent],
      { cwd: checkout, env, encoding: "utf8" },
    );
    return { stream: result.stdout, exitCode: result.status };
  }

  const say = (text: string) =>
    `printf '%s\\n' '${JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] } })}'`;
  const commit = (file: string) =>
    `echo change >${file} && git add ${file} && git commit -q -m "Add ${file}"`;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "gitflare-sessions-"));
    checkout = join(root, "workspace");
    // Nothing of the machine's own git configuration: no signing, no hooks, no identity.
    // Without coreutils, a stand-in that runs the command with no limit.
    const bin = join(root, "bin");
    mkdirSync(bin);
    if (!timeoutInstalled) {
      writeFileSync(join(bin, "timeout"), '#!/bin/sh\nshift 2\nexec "$@"\n');
      chmodSync(join(bin, "timeout"), 0o755);
    }
    env = {
      PATH: `${bin}:${process.env.PATH}`,
      HOME: root,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    };
    const origin = join(root, "fork.git");
    const seed = join(root, "seed");
    git(root, "init", "-q", "--bare", "-b", "main", origin);
    git(root, "init", "-q", "-b", "main", seed);
    writeFileSync(join(seed, "README.md"), "hello\n");
    git(seed, "add", "README.md");
    git(
      seed,
      "-c",
      "user.name=Seed",
      "-c",
      "user.email=seed@x.test",
      "commit",
      "-q",
      "-m",
      "First",
    );
    git(seed, "push", "-q", origin, "main");
    // A URL, not a path: git ignores `--depth` for a local path.
    remote = `file://${origin}`;
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("checks out the fork on a new session branch, shallow, as the session's owner", () => {
    // What an interrupted start left behind.
    mkdirSync(join(checkout, "stale"), { recursive: true });

    expect(runCheckout("audit-log-export").status).toBe(0);

    expect(git(checkout, "rev-parse", "--abbrev-ref", "HEAD")).toBe("audit-log-export");
    expect(git(checkout, "rev-parse", "HEAD")).toBe(git(checkout, "rev-parse", "origin/main"));
    expect(git(checkout, "rev-parse", "--is-shallow-repository")).toBe("true");
    expect(git(checkout, "config", "user.email")).toBe("maya@x.test");
    expect(git(checkout, "status", "--porcelain")).toBe("");
    // Nothing was pushed: a branch equal to main would open an empty change.
    expect(git(root, "ls-remote", "--heads", remote)).not.toContain("audit-log-export");
  });

  it("fails when the fork cannot be reached", () => {
    remote = `file://${join(root, "missing.git")}`;
    expect(runCheckout("audit-log-export").status).not.toBe(0);
  });

  it("stamps the agent's events, pushes what it committed, and says so", () => {
    runCheckout("audit-log-export");

    const { stream, exitCode } = runTurn(
      "audit-log-export",
      [
        `echo '{"type":"system","subtype":"init"}'`,
        "echo 'a warning that is not JSON'",
        say("Adding the export."),
        commit("export.ts"),
        `echo '{"type":"result","is_error":false,"result":"Done."}'`,
      ].join(" && "),
    );

    expect(exitCode).toBe(0);
    const head = git(checkout, "rev-parse", "HEAD");
    expect(git(root, "ls-remote", "--heads", remote, "audit-log-export")).toContain(head);
    // Only the events a session shows are kept, each on one line with its time.
    const lines = stream
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(lines).toHaveLength(3);
    for (const line of lines) expect(Math.abs(line.at - Date.now())).toBeLessThan(60_000);
    expect(parseAgentEvents("ses_test", stream, 0)).toMatchObject([
      { seq: 1, type: "assistant", text: "Adding the export." },
      { seq: 2, type: "pushed", sha: head },
    ]);
  });

  it("pushes nothing when the agent committed nothing", () => {
    runCheckout("audit-log-export");
    const { stream } = runTurn("audit-log-export", say("Nothing to change."));
    expect(parseAgentEvents("ses_test", stream, 0)).toMatchObject([{ type: "assistant" }]);
    expect(git(root, "ls-remote", "--heads", remote)).not.toContain("audit-log-export");
  });

  it("pushes each turn's commits once", () => {
    runCheckout("audit-log-export");
    runTurn("audit-log-export", commit("one.ts"));
    const quiet = runTurn("audit-log-export", say("Looked around."));
    expect(quiet.stream).not.toContain("pushed");

    const second = runTurn("audit-log-export", commit("two.ts"));
    const head = git(checkout, "rev-parse", "HEAD");
    expect(parseAgentEvents("ses_test", second.stream, 0)).toMatchObject([
      { type: "pushed", sha: head },
    ]);
  });

  it("exits with the agent's code, and still pushes what it committed first", () => {
    runCheckout("audit-log-export");
    const { stream, exitCode } = runTurn("audit-log-export", `${commit("half.ts")} && exit 3`);
    expect(exitCode).toBe(3);
    expect(parseAgentEvents("ses_test", stream, 0)).toMatchObject([{ type: "pushed" }]);
  });

  it.skipIf(!timeoutInstalled)(
    "stops an agent that runs out of time, and still pushes its commits",
    () => {
      runCheckout("audit-log-export");

      const { stream, exitCode } = runTurn(
        "audit-log-export",
        `${commit("slow.ts")} && sleep 30`,
        1,
      );

      expect(exitCode).toBe(124);
      const head = git(checkout, "rev-parse", "HEAD");
      expect(git(root, "ls-remote", "--heads", remote, "audit-log-export")).toContain(head);
      expect(parseAgentEvents("ses_test", stream, 0)).toMatchObject([
        { type: "pushed", sha: head },
      ]);
    },
  );

  it("says when the push is refused", () => {
    runCheckout("audit-log-export");
    git(checkout, "remote", "set-url", "origin", `file://${join(root, "missing.git")}`);
    const { stream } = runTurn("audit-log-export", commit("lost.ts"));
    expect(parseAgentEvents("ses_test", stream, 0)).toMatchObject([
      { type: "error", message: "The agent's commits could not be pushed to the fork." },
    ]);
  });

  it("resumes on the branch a stopped session pushed", () => {
    runCheckout("audit-log-export");
    runTurn("audit-log-export", commit("export.ts"));
    const pushed = git(checkout, "rev-parse", "HEAD");

    expect(runCheckout("audit-log-export").status).toBe(0);

    expect(git(checkout, "rev-parse", "--abbrev-ref", "HEAD")).toBe("audit-log-export");
    expect(git(checkout, "rev-parse", "HEAD")).toBe(pushed);
    // What it resumed from is already on the fork.
    expect(runTurn("audit-log-export", say("Back.")).stream).not.toContain("pushed");
  });
});
