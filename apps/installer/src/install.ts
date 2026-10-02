import { CloudflareApiError } from "./cloudflare.ts";
import type { InstallPorts, InstallStep, StepResult } from "./plan.ts";
import { links } from "./steps.ts";

/** The plan as `--dry-run` prints it: every step, in order, numbered. */
export function formatPlan(steps: InstallStep[]): string {
  const width = String(steps.length).length;
  return steps
    .map(
      (step, index) =>
        `${String(index + 1).padStart(width)}. ${`[${step.kind}]`.padEnd(8)} ${step.title}`,
    )
    .join("\n");
}

/** A step failed in a way no dashboard visit fixes. Its message names the step. */
export class StepFailedError extends Error {
  readonly step: InstallStep;

  constructor(step: InstallStep, cause: unknown) {
    super(`"${step.title}" failed: ${cause instanceof Error ? cause.message : String(cause)}`, {
      cause,
    });
    this.name = "StepFailedError";
    this.step = step;
  }
}

export interface InstallOutcome {
  /** One entry per step that ran, in order. A blocked step is the last. */
  results: { step: InstallStep; result: StepResult }[];
  blocked: { step: InstallStep; detail: string; url: string } | null;
}

/**
 * Runs the plan in order and stops at the first step that is blocked. Nothing
 * is rolled back: every step looks before it creates, so the fix is to meet the
 * precondition and run the installer again.
 */
export async function runInstall(
  steps: InstallStep[],
  ports: InstallPorts,
): Promise<InstallOutcome> {
  const outputs: Record<string, string> = {};
  const results: InstallOutcome["results"] = [];
  for (const step of steps) {
    let result: StepResult;
    try {
      result = await step.run(ports, outputs);
    } catch (error) {
      if (
        !(error instanceof CloudflareApiError) ||
        (error.status !== 401 && error.status !== 403)
      ) {
        throw new StepFailedError(step, error);
      }
      result = {
        status: "blocked",
        detail: `Cloudflare refused "${step.title}" (${error.message}). Either the API token lacks the permission for it, or the product is not enabled on the account.`,
        url: links.apiTokens,
      };
    }
    results.push({ step, result });
    ports.prompt.note(`${mark[result.status]} ${step.title}: ${result.detail}`);
    if (result.status === "blocked") {
      return { results, blocked: { step, detail: result.detail, url: result.url } };
    }
    Object.assign(outputs, result.outputs);
  }
  return { results, blocked: null };
}

const mark = { done: "+", unchanged: "=", blocked: "!" } as const;
