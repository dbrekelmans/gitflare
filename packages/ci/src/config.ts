import { CI_CONFIG_PATH, CiConfig, CiStepConfig, ForgeError } from "@gitflare/core";
import { parse } from "yaml";
import { z } from "zod";

// A misspelt key (`need:`) would otherwise be dropped and the file accepted.
const StrictCiConfig = CiConfig.extend({
  steps: z.array(CiStepConfig.strict()).min(1),
}).strict();

function invalid(problem: string): ForgeError {
  return new ForgeError("invalid", `${CI_CONFIG_PATH}: ${problem}`);
}

/** Parses and validates a CI file. Throws a `ForgeError` (`invalid`) that names the problem. */
export function parseCiConfig(yaml: string): CiConfig {
  let data: unknown;
  try {
    data = parse(yaml);
  } catch (error) {
    throw invalid(`not valid YAML: ${error instanceof Error ? error.message : String(error)}`);
  }
  const parsed = StrictCiConfig.safeParse(data);
  if (!parsed.success) {
    const [issue] = parsed.error.issues;
    const where = issue?.path.join(".");
    throw invalid(where ? `${where}: ${issue?.message}` : (issue?.message ?? "not a CI file"));
  }
  // A file that cannot be planned is refused here, with the rest of its mistakes.
  planSteps(parsed.data);
  return parsed.data;
}

/**
 * The order to run steps in: each inner array is a wave whose steps have all
 * their `needs` met and can run in parallel. Throws on a cycle or an unknown
 * need.
 */
export function planSteps(config: CiConfig): string[][] {
  const names = new Set<string>();
  for (const step of config.steps) {
    if (names.has(step.name)) throw invalid(`two steps are named ${step.name}`);
    names.add(step.name);
  }
  for (const step of config.steps) {
    const unknown = step.needs.find((need) => !names.has(need));
    if (unknown) throw invalid(`step ${step.name} needs ${unknown}, which is not a step`);
  }

  const waves: string[][] = [];
  const done = new Set<string>();
  let waiting = config.steps;
  while (waiting.length > 0) {
    const wave = waiting.filter((step) => step.needs.every((need) => done.has(need)));
    if (wave.length === 0) {
      const stuck = waiting.map((step) => step.name).join(", ");
      throw invalid(`these steps need each other in a circle: ${stuck}`);
    }
    for (const step of wave) done.add(step.name);
    waves.push(wave.map((step) => step.name));
    waiting = waiting.filter((step) => !done.has(step.name));
  }
  return waves;
}
