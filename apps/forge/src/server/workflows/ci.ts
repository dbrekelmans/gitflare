import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { closeCiRun, finishCiRun, pollCiStep, startCiRun, startCiStep } from "@gitflare/ci";
import {
  CI_FINISHED_EVENT,
  type CiFinishedPayload,
  type CiRunId,
  type CiWorkflowParams,
  ForgeError,
  type StageInput,
} from "@gitflare/core";
import { getServices, type Services } from "../services";

/** What the Workflow runs on: the services, and how the waiting pipeline instance is told the result. */
export interface CiRuntime {
  services: Services;
  notify(env: Env, instanceId: string, outcome: CiFinishedPayload): Promise<void>;
}

/** Sends `CI_FINISHED_EVENT` to the pipeline instance that started this run. */
export async function notifyPipeline(
  env: Env,
  instanceId: string,
  outcome: CiFinishedPayload,
): Promise<void> {
  const pipeline = await env.CHANGE_PIPELINE.get(instanceId);
  await pipeline.sendEvent({ type: CI_FINISHED_EVENT, payload: outcome });
}

/**
 * Replaceable so that a Worker test can drive the Workflow on fakes, as
 * `pipelineRuntime` is. Nothing else assigns it.
 */
export const ciRuntime: { create: () => CiRuntime } = {
  create: () => ({ services: getServices(), notify: notifyPipeline }),
};

const quick = {
  retries: { limit: 3, delay: "2 seconds", backoff: "exponential" },
  timeout: "2 minutes",
} as const;
// Starting a run boots a sandbox and waits for the setup command, which is
// given fifteen minutes.
const patient = {
  retries: { limit: 3, delay: "5 seconds", backoff: "exponential" },
  timeout: "20 minutes",
} as const;

/** How long to wait before asking about a step again: output arrives promptly at first, then cheaply. */
function pollDelay(polls: number): "2 seconds" | "5 seconds" {
  return polls < 30 ? "2 seconds" : "5 seconds";
}

/**
 * An expected refusal will not go away on a retry. A sandbox that could not
 * be asked is not a refusal: `@gitflare/ci` throws `CiInterrupted` for it,
 * which is retried like any other error.
 */
async function once<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof ForgeError) throw new NonRetryableError(error.message);
    throw error;
  }
}

/** A failed step's message, without the error class the Workflows engine puts in front of a refusal. */
function describe(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^NonRetryableError: /, "");
}

/**
 * CI for one revision of one change, started by the change pipeline. It
 * drives `@gitflare/ci` one Workflow step at a time: start the run, then for
 * each wave of steps start them and poll with `step.sleep` between polls,
 * then finish. When it is done it sends `CI_FINISHED_EVENT` with a
 * `CiFinishedPayload` to the pipeline instance named in its params.
 * Build task: `ci`.
 */
export class CiWorkflow extends WorkflowEntrypoint<Env, CiWorkflowParams> {
  async run(event: WorkflowEvent<CiWorkflowParams>, step: WorkflowStep): Promise<void> {
    const { services, notify } = ciRuntime.create();
    const { notifyInstanceId, ...input } = event.payload;

    let outcome: CiFinishedPayload;
    try {
      outcome = await this.runCi(services, step, input);
    } catch (error) {
      // Whatever went wrong, the pipeline is told: it must not wait out its timeout.
      const reason = describe(error);
      outcome = { status: "failed", reason };
      // A start or a finish that ran out of retries can leave the run open
      // and its sandbox up. Failing to close it must not hide why it failed.
      await step
        .do("close the run", quick, () =>
          once(() => closeCiRun(services, input.stageRunId, reason)),
        )
        .catch(() => {});
    }
    await step.do("report the result", quick, () => notify(this.env, notifyInstanceId, outcome));
  }

  private async runCi(
    services: Services,
    step: WorkflowStep,
    input: StageInput,
  ): Promise<CiFinishedPayload> {
    const start = await step.do("start the run", patient, () =>
      once(() => startCiRun(services, input)),
    );
    if (start.status === "skipped") return start;

    let broken: string | null = null;
    try {
      for (const wave of start.waves) {
        // Every step of the wave is seen to its end before the run moves on or is closed.
        const results = await Promise.allSettled(
          wave.map((name) => this.runStep(services, step, start.run.id, name)),
        );
        for (const result of results) if (result.status === "rejected") throw result.reason;
      }
    } catch (error) {
      broken = describe(error);
    }
    // Always, once the run has started: this is what stops the sandbox and closes the record.
    const outcome = await step.do("finish the run", quick, () =>
      once(() => finishCiRun(services, start.run.id)),
    );
    return broken ? { status: "failed", reason: `CI could not finish: ${broken}` } : outcome;
  }

  private async runStep(
    services: Services,
    step: WorkflowStep,
    runId: CiRunId,
    name: string,
  ): Promise<void> {
    let ciStep = await step.do(`start ${name}`, quick, () =>
      once(() => startCiStep(services, runId, name)),
    );
    for (let polls = 0; ciStep.status === "running"; polls++) {
      // A quick step is settled by the first poll, without a sleep.
      if (polls > 0) await step.sleep(`wait for ${name}, ${polls}`, pollDelay(polls));
      const { id } = ciStep;
      ciStep = await step.do(`poll ${name}, ${polls}`, quick, () =>
        once(() => pollCiStep(services, id)),
      );
    }
  }
}
