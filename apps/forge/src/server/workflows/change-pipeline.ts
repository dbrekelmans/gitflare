import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import {
  ArtifactsPushEvent,
  type ChangeId,
  CI_FINISHED_EVENT,
  type CiFinishedPayload,
  type CiWorkflowParams,
  ForgeError,
  type PipelineParams,
  type StageHandler,
  type StageInput,
  type StageName,
  type StageRun,
  toPush,
} from "@gitflare/core";
import { runIntentStage } from "@gitflare/intent";
import {
  CHECKPOINT_POLL_MS,
  CHECKPOINT_WAIT_MS,
  handlePush,
  missingCheckpoints,
  queueStageRerun,
  recordStageOutcome,
  runStage,
  settleChange,
  startStage,
} from "@gitflare/pipeline";
import { runReviewStage } from "@gitflare/review";
import { runSectionsStage } from "@gitflare/sections";
import { getServices, type Services } from "../services";

/** What the Workflow runs on: the services, the three stages it runs itself, and how CI is started. */
export interface PipelineRuntime {
  services: Services;
  stages: Record<Exclude<StageName, "ci">, StageHandler<Services>>;
  /** Starts the CI Workflow for one attempt. It answers with `CI_FINISHED_EVENT`. */
  startCi(env: Env, params: CiWorkflowParams): Promise<void>;
}

/**
 * Replaceable so that a Worker test can drive the Workflow on fakes: a
 * Workflow instance is constructed by the runtime and cannot be handed its
 * dependencies. Nothing else assigns it.
 */
export const pipelineRuntime: { create: () => PipelineRuntime } = {
  create: () => ({
    services: getServices(),
    stages: { intent: runIntentStage, sections: runSectionsStage, review: runReviewStage },
    // The attempt's id is the instance's: a retried step finds the instance it already started.
    startCi: (env, params) => ensureInstance(env.CI, params.stageRunId, params),
  }),
};

/** Creates the instance with this id unless it exists: an id can be used once. */
async function ensureInstance<Params>(
  workflow: Workflow<Params>,
  id: string,
  params: Params,
): Promise<void> {
  try {
    await workflow.create({ id, params });
  } catch (error) {
    if (!(await workflow.get(id).catch(() => null))) throw error;
  }
}

// A stage that fails is recorded as failed by `runStage`. A retry here is for the
// bookkeeping around it, and one is enough: a handler that hangs is not asked a third time.
const stageStep = { retries: { limit: 1, delay: "5 seconds" }, timeout: "15 minutes" } as const;
// Capture is evidence, never a gate: one quick retry, then on without it.
const checkpointStep = { retries: { limit: 1, delay: "1 second" }, timeout: "30 seconds" } as const;
/** Long enough for any CI run; after it the stage is failed so the change is not left processing. */
const CI_TIMEOUT = "2 hours";

/** An expected refusal will not go away on a retry. */
async function once<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof ForgeError) throw new NonRetryableError(error.message);
    throw error;
  }
}

function inputOf(run: StageRun): StageInput {
  const { changeId, revisionId, id: stageRunId, attempt } = run;
  return { changeId, revisionId, stageRunId, attempt };
}

/**
 * The change pipeline. An instance is started by the Artifacts push trigger
 * (its payload is then the raw push event, with no `kind`), or by the forge
 * with `PipelineParams` to raise a push by hand or re-run a stage.
 *
 * It is a thin sequence of `step.do` calls over `@gitflare/pipeline` and the
 * stage handlers: handle the push; wait briefly for checkpoints; run intent,
 * sections and review in parallel while the CI Workflow runs; settle the
 * change. All logic and every database write lives in the packages.
 *
 * Several instances can hold the same queued stage runs: the same push
 * delivered twice, two pushes that both read the newer tip, a re-run asked
 * for twice. Exactly one runs them: the instance whose id is derived from the
 * runs. Any other instance creates that one, which the platform does at most
 * once per id, and ends.
 * Build task: `pipeline`.
 */
export class ChangePipelineWorkflow extends WorkflowEntrypoint<Env, PipelineParams> {
  async run(event: WorkflowEvent<PipelineParams>, step: WorkflowStep): Promise<void> {
    const runtime = pipelineRuntime.create();
    const { services } = runtime;
    const params = readParams(event.payload);

    if (params.kind === "rerun") {
      const run = await step.do("queue the re-run", () =>
        once(() => queueStageRerun(services, params.changeId, params.stage)),
      );
      if (await this.handOver(step, event.instanceId, run, params)) return;
      await this.runStages(runtime, step, event.instanceId, [run]);
      return;
    }

    const result = await step.do("handle the push", () =>
      once(() => handlePush(services, params.push)),
    );
    if (result.kind !== "change") return;
    // A push delivered after its stages started has nothing left to run.
    const queued = result.stages.filter((run) => run.status === "queued");
    const [first] = result.stages;
    if (queued.length === 0 || !first) return;
    if (await this.handOver(step, event.instanceId, first, params)) return;
    await this.waitForCheckpoints(services, step, result.changeId);
    await this.runStages(runtime, step, event.instanceId, queued);
  }

  /** True when another instance runs these stages: this one has made sure it exists. */
  private async handOver(
    step: WorkflowStep,
    instanceId: string,
    first: StageRun,
    params: PipelineParams,
  ): Promise<boolean> {
    const runner = `stages-${first.id}`;
    if (instanceId === runner) return false;
    await step.do("hand the stages to their runner", () =>
      ensureInstance(this.env.CHANGE_PIPELINE, runner, params),
    );
    return true;
  }

  private async waitForCheckpoints(
    services: Services,
    step: WorkflowStep,
    changeId: ChangeId,
  ): Promise<void> {
    try {
      for (let waited = 0; ; waited += CHECKPOINT_POLL_MS) {
        const missing = await step.do(
          `look for checkpoints after ${waited} ms`,
          checkpointStep,
          () => missingCheckpoints(services, changeId),
        );
        if (missing.length === 0 || waited >= CHECKPOINT_WAIT_MS) return;
        await step.sleep(`wait for checkpoints after ${waited} ms`, CHECKPOINT_POLL_MS);
      }
    } catch (error) {
      // The change page says which checkpoints are missing; the stages run without them.
      console.warn(`change ${changeId}: gave up waiting for checkpoints`, error);
    }
  }

  private async runStages(
    runtime: PipelineRuntime,
    step: WorkflowStep,
    instanceId: string,
    runs: StageRun[],
  ): Promise<void> {
    const { services, stages } = runtime;
    await Promise.all(
      runs.map(async (run) => {
        const { stage } = run;
        const input = inputOf(run);
        try {
          if (stage === "ci") {
            await this.runCi(runtime, step, instanceId, input);
          } else {
            await step.do(`run ${stage}`, stageStep, async () => {
              await runStage(services, stages[stage], services, { ...input, stage });
            });
          }
        } catch (error) {
          // The step itself gave out. The stage must still settle, or the change never would.
          const reason = error instanceof Error ? error.message : String(error);
          await step.do(`fail ${stage}`, async () => {
            await recordStageOutcome(services, input, { status: "failed", reason });
          });
        }
        await step.do(`settle after ${stage}`, async () => {
          await settleChange(services, input.changeId);
        });
      }),
    );
  }

  private async runCi(
    runtime: PipelineRuntime,
    step: WorkflowStep,
    instanceId: string,
    input: StageInput,
  ): Promise<void> {
    const { services } = runtime;
    const started = await step.do("start ci", async () => {
      const run = await startStage(services, input);
      if (run.status !== "running") return false;
      await runtime.startCi(this.env, { ...input, notifyInstanceId: instanceId });
      return true;
    });
    // Skipped: a later push replaced the revision, or the change ended.
    if (!started) return;
    const outcome = await step
      .waitForEvent<CiFinishedPayload>("wait for ci", {
        type: CI_FINISHED_EVENT,
        timeout: CI_TIMEOUT,
      })
      .then(
        (finished) => finished.payload,
        (): CiFinishedPayload => ({
          status: "failed",
          reason: `CI did not report a result within ${CI_TIMEOUT}.`,
        }),
      );
    await step.do("record ci", async () => {
      await recordStageOutcome(services, input, outcome);
    });
  }
}

/** The push trigger delivers the raw Artifacts event; the forge sends `PipelineParams`. */
function readParams(payload: unknown): PipelineParams {
  if (typeof payload === "object" && payload !== null && "kind" in payload) {
    return payload as PipelineParams;
  }
  const event = ArtifactsPushEvent.safeParse(payload);
  if (!event.success) throw new NonRetryableError("not a push event and not pipeline parameters");
  return { kind: "push", push: toPush(event.data) };
}
