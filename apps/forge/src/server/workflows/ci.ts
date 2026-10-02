import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import type { CiWorkflowParams } from "@gitflare/core";

/**
 * CI for one revision of one change, started by the change pipeline. It
 * drives `@gitflare/ci` one Workflow step at a time: start the run, then for
 * each wave of steps start them and poll with `step.sleep` between polls,
 * then finish. When it is done it sends `CI_FINISHED_EVENT` with a
 * `CiFinishedPayload` to the pipeline instance named in its params.
 * Build task: `ci`.
 */
export class CiWorkflow extends WorkflowEntrypoint<Env, CiWorkflowParams> {
  async run(_event: WorkflowEvent<CiWorkflowParams>, _step: WorkflowStep): Promise<void> {
    throw new NonRetryableError("not implemented: CiWorkflow");
  }
}
