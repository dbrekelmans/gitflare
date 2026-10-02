import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { scripts } from "./scripts";

const setupScript = readFileSync(
  new URL("../../../apps/forge/containers/workspace/setup.sh", import.meta.url),
  "utf8",
);

function shellcheckInstalled(): boolean {
  try {
    execFileSync("shellcheck", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Runs shellcheck over a script on stdin and returns what it reported: nothing, for a clean script. */
function shellcheck(script: string): string {
  try {
    execFileSync("shellcheck", ["--shell=sh", "--severity=style", "-"], { input: script });
    return "";
  } catch (error) {
    return String((error as { stdout?: Buffer }).stdout ?? error);
  }
}

const installed = shellcheckInstalled();

describe("shell", () => {
  // GitHub's runners ship shellcheck. A developer's machine may not: there the
  // checks are skipped, but CI must never pass because the tool went missing.
  it("is checked in CI", () => {
    if (process.env.CI) expect(installed).toBe(true);
  });

  it.skipIf(!installed)("setup.sh passes shellcheck", () => {
    expect(shellcheck(setupScript)).toBe("");
  });

  it.skipIf(!installed)("shellcheck is really looking", () => {
    expect(shellcheck("#!/bin/sh\nrm -rf $1/*\n")).toContain("SC2086");
  });

  it.skipIf(!installed).each(Object.entries(scripts))(
    "the %s script passes shellcheck",
    (_name, script) => {
      expect(shellcheck(`#!/bin/sh\n${script}\n`)).toBe("");
    },
  );
});

describe("setup.sh", () => {
  it("stops at the first failing command", () => {
    expect(setupScript).toMatch(/^#!\/bin\/sh\n/);
    expect(setupScript).toMatch(/^set -eu$/m);
  });

  it("pins what it installs", () => {
    expect(setupScript).toMatch(/^CLAUDE_CODE_VERSION=\d+\.\d+\.\d+$/m);
    expect(setupScript).toMatch(/^ENTIRE_VERSION=\d+\.\d+\.\d+$/m);
    expect(setupScript).toMatch(/^PNPM_VERSION=\d+\.\d+\.\d+$/m);
    // Every version it names is exact, not only the ones listed here.
    for (const [line] of setupScript.matchAll(/^\w+_VERSION=.*$/gm)) {
      expect(line).toMatch(/^\w+_VERSION=\d+\.\d+\.\d+$/);
    }
    expect(setupScript).not.toContain("@latest");
  });

  it("verifies the capture client's checksum before installing it", () => {
    const check = setupScript.indexOf("sha256sum -c");
    expect(check).toBeGreaterThan(-1);
    expect(setupScript.indexOf("install -m 0755")).toBeGreaterThan(check);
  });
});
