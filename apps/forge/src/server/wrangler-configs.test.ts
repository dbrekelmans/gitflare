import { readFileSync } from "node:fs";
import { ARTIFACTS_PUSH_EVENT, workflowNames } from "@gitflare/core";
import { describe, expect, it } from "vitest";

interface WranglerConfig {
  main: string;
  compatibility_date: string;
  durable_objects: { bindings: { name: string; class_name: string }[] };
  exports: Record<string, { type: string; storage?: string }>;
  workflows: { name: string; binding: string; class_name: string }[];
  containers?: { class_name: string }[];
  triggers?: { events: { type: string; targets: { workflow_name: string }[] }[] };
}

/** JSONC to JSON: drops comments and trailing commas. Enough for these two files. */
function readConfig(name: string): WranglerConfig {
  const text = readFileSync(new URL(`../../${name}`, import.meta.url), "utf8");
  const json = text
    .replace(/("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (_match, string) => string ?? "")
    .replace(/,(\s*[}\]])/g, "$1");
  return JSON.parse(json);
}

const local = readConfig("wrangler.jsonc");
const deploy = readConfig("wrangler.deploy.jsonc");
const entry = readFileSync(new URL("../server.ts", import.meta.url), "utf8");
const testEntry = readFileSync(new URL("./test-entry.ts", import.meta.url), "utf8");

describe("the two Wrangler configs", () => {
  it("declare the same Durable Objects and Workflows", () => {
    expect(deploy.durable_objects).toEqual(local.durable_objects);
    expect(deploy.exports).toEqual(local.exports);
    expect(deploy.workflows).toEqual(local.workflows);
    expect(deploy.main).toBe(local.main);
    expect(deploy.compatibility_date).toBe(local.compatibility_date);
  });

  it("name Workflows the way the code addresses them", () => {
    expect(local.workflows.map((workflow) => workflow.name).sort()).toEqual(
      Object.values(workflowNames).sort(),
    );
  });

  it("export every declared class from both entries", () => {
    const classes = [
      ...local.durable_objects.bindings.map((binding) => binding.class_name),
      ...local.workflows.map((workflow) => workflow.class_name),
    ];
    for (const name of classes) {
      expect(entry).toContain(name);
      expect(testEntry).toContain(name);
    }
    for (const binding of local.durable_objects.bindings) {
      expect(local.exports[binding.class_name]).toEqual({
        type: "durable-object",
        storage: "sqlite",
      });
    }
  });

  it("trigger the change pipeline on every push, in the deployed config only", () => {
    expect(local.triggers).toBeUndefined();
    expect(local.containers).toBeUndefined();
    expect(deploy.triggers?.events).toHaveLength(1);
    expect(deploy.triggers?.events[0]?.type).toBe(ARTIFACTS_PUSH_EVENT);
    expect(deploy.triggers?.events[0]?.targets[0]?.workflow_name).toBe(
      workflowNames.changePipeline,
    );
    expect(deploy.containers?.[0]?.class_name).toBe("SandboxRoom");
  });
});
