import {
  type CiConfig,
  type CiRun,
  type CiStep,
  type CiStepId,
  notImplemented,
  type StageInput,
  type StageOutcome,
} from "@gitflare/core";
import type { ChangeLive, Clock, GitHost, IdGenerator, SandboxHost } from "@gitflare/core/ports";
import type { Db } from "@gitflare/db";

// @gitflare/ci — ordinary CI for a change: read the repository's
// `.gitflare/ci.yml` at the head commit, check the head out in a sandbox, run
// the steps, record each step and stream its output. The CI Workflow in
// `apps/forge/src/server/workflows/ci.ts` drives these functions, one
// Workflow step per call, so each must be safe to run twice. Build task: `ci`.

export interface CiDeps {
  db: Db;
  git: GitHost;
  sandboxes: SandboxHost;
  live: ChangeLive;
  clock: Clock;
  ids: IdGenerator;
}

/** Parses and validates a CI file. Throws a `ForgeError` (`invalid`) that names the problem. */
export function parseCiConfig(_yaml: string): CiConfig {
  return notImplemented("@gitflare/ci parseCiConfig");
}

/**
 * The order to run steps in: each inner array is a wave whose steps have all
 * their `needs` met and can run in parallel. Throws on a cycle or an unknown
 * need.
 */
export function planSteps(_config: CiConfig): string[][] {
  return notImplemented("@gitflare/ci planSteps");
}

export type CiStart =
  | { status: "started"; run: CiRun; waves: string[][] }
  /** The repository has no CI file at this commit: the stage is skipped. */
  | { status: "skipped"; reason: string };

/** Reads the CI file, creates the run and its steps, starts the sandbox and checks the head out. */
export async function startCiRun(_deps: CiDeps, _input: StageInput): Promise<CiStart> {
  return notImplemented("@gitflare/ci startCiRun");
}

/** Starts one step's command in the run's sandbox. Returns at once; the command runs in the background. */
export async function startCiStep(
  _deps: CiDeps,
  _runId: CiRun["id"],
  _name: string,
): Promise<CiStep> {
  return notImplemented("@gitflare/ci startCiStep");
}

/**
 * Forwards output written since the last call as `ci.log` signals, and, when
 * the command has exited, records the step's result. Returns the step; the
 * caller sleeps and calls again while it is `running`.
 */
export async function pollCiStep(_deps: CiDeps, _stepId: CiStepId): Promise<CiStep> {
  return notImplemented("@gitflare/ci pollCiStep");
}

/** Stops the sandbox, settles the run from its steps, and says how the stage ended. */
export async function finishCiRun(
  _deps: CiDeps,
  _runId: CiRun["id"],
): Promise<StageOutcome | { status: "failed"; reason: string }> {
  return notImplemented("@gitflare/ci finishCiRun");
}

/** A step's output: the whole log while its sandbox is alive, the stored tail afterwards. */
export async function readStepLog(
  _deps: Pick<CiDeps, "db" | "sandboxes">,
  _stepId: CiStepId,
): Promise<{ text: string; complete: boolean }> {
  return notImplemented("@gitflare/ci readStepLog");
}
