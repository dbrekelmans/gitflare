import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import type { PipelineParams } from "@gitflare/core";

/**
 * The change pipeline. An instance is started by the Artifacts push trigger
 * (its payload is then the raw push event, with no `kind`), or by the forge
 * with `PipelineParams` to raise a push by hand or re-run a stage.
 *
 * It is a thin sequence of `step.do` calls over `@gitflare/pipeline` and the
 * stage handlers: handle the push; wait briefly for checkpoints; run intent,
 * sections and review in parallel while the CI Workflow runs; settle the
 * change. All logic and every database write lives in the packages.
 * Build task: `pipeline`.
 */
export class ChangePipelineWorkflow extends WorkflowEntrypoint<Env, PipelineParams> {
  async run(_event: WorkflowEvent<PipelineParams>, _step: WorkflowStep): Promise<void> {
    throw new NonRetryableError("not implemented: ChangePipelineWorkflow");
  }
}
