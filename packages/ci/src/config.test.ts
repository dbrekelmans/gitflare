import { execFileSync } from "node:child_process";
import { ForgeError } from "@gitflare/core";
import { describe, expect, it } from "vitest";
import { CHECKOUT_SCRIPT, parseCiConfig, planSteps, RUN_SCRIPT } from "./index";

function refusal(yaml: string): string {
  try {
    parseCiConfig(yaml);
  } catch (error) {
    expect(error).toBeInstanceOf(ForgeError);
    expect((error as ForgeError).code).toBe("invalid");
    return (error as ForgeError).message;
  }
  throw new Error("the file was accepted");
}

describe("parseCiConfig", () => {
  it("reads a CI file and fills in what it leaves out", () => {
    const config = parseCiConfig(`setup: pnpm install --frozen-lockfile
steps:
  - name: lint
    run: pnpm lint
  - name: test
    run: |
      pnpm build
      pnpm test
    needs: [lint]
    timeoutMinutes: 30
`);

    expect(config).toEqual({
      setup: "pnpm install --frozen-lockfile",
      instance: "standard-2",
      egress: { hosts: [] },
      steps: [
        { name: "lint", run: "pnpm lint", needs: [], timeoutMinutes: 15 },
        { name: "test", run: "pnpm build\npnpm test\n", needs: ["lint"], timeoutMinutes: 30 },
      ],
    });
  });

  it("names what is wrong with a file it refuses", () => {
    expect(refusal("steps: [")).toContain("not valid YAML");
    expect(refusal("setup: pnpm install\n")).toContain("steps");
    expect(refusal("steps: []\n")).toContain("steps");
    expect(refusal("steps:\n  - name: Lint It\n    run: x\n")).toContain("steps.0.name");
    expect(refusal("steps:\n  - name: a\n    run: x\n    timeoutMinutes: 600\n")).toContain(
      "steps.0.timeoutMinutes",
    );
  });

  it("refuses a key it does not know rather than ignoring it", () => {
    expect(refusal("steps:\n  - name: a\n    run: x\n    need: [b]\n")).toContain("need");
    expect(refusal("step:\n  - name: a\n    run: x\n")).toMatch(/step/);
  });

  it("refuses a file whose steps cannot be ordered", () => {
    const step = (name: string, needs: string) =>
      `  - name: ${name}\n    run: x\n    needs: [${needs}]\n`;
    expect(refusal(`steps:\n${step("a", "")}${step("a", "")}`)).toContain("two steps are named a");
    expect(refusal(`steps:\n${step("a", "b")}`)).toContain("a needs b, which is not a step");
    expect(refusal(`steps:\n${step("a", "a")}`)).toContain("circle: a");
    expect(refusal(`steps:\n${step("a", "c")}${step("b", "a")}${step("c", "b")}`)).toContain(
      "circle: a, b, c",
    );
  });
});

describe("planSteps", () => {
  const config = (steps: Record<string, string[]>) =>
    parseCiConfig(
      JSON.stringify({
        steps: Object.entries(steps).map(([name, needs]) => ({ name, run: "x", needs })),
      }),
    );

  it("runs steps with no needs together", () => {
    expect(planSteps(config({ typecheck: [], lint: [], test: [] }))).toEqual([
      ["typecheck", "lint", "test"],
    ]);
  });

  it("puts a step in the first wave after everything it needs", () => {
    const waves = planSteps(
      config({
        deploy: ["build", "test"],
        build: ["install"],
        test: ["install"],
        install: [],
        docs: [],
      }),
    );

    expect(waves).toEqual([["install", "docs"], ["build", "test"], ["deploy"]]);
  });
});

function shellcheckInstalled(): boolean {
  try {
    execFileSync("shellcheck", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// As in `@gitflare/sandbox`: skipped where the tool is missing, which CI is not allowed to be.
describe("the scripts run in the sandbox", () => {
  const installed = shellcheckInstalled();

  it("are checked in CI", () => {
    if (process.env.CI) expect(installed).toBe(true);
  });

  it.skipIf(!installed).each([
    ["checkout", CHECKOUT_SCRIPT],
    ["run", RUN_SCRIPT],
  ])("the %s script passes shellcheck", (_name, script) => {
    let report = "";
    try {
      execFileSync("shellcheck", ["--shell=sh", "--severity=style", "-"], {
        input: `#!/bin/sh\n${script}\n`,
      });
    } catch (error) {
      report = String((error as { stdout?: Buffer }).stdout ?? error);
    }
    expect(report).toBe("");
  });
});
