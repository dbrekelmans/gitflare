import type { ChangeId, RepositoryId, RevisionId, SessionId, StageRunId } from "../ids";
import type { StageName } from "./change";
import type { Push } from "./push";

/** Which attempt of which stage a handler is running. */
export interface StageInput {
  changeId: ChangeId;
  revisionId: RevisionId;
  stageRunId: StageRunId;
  attempt: number;
}

/**
 * How a stage ended, when it did not fail. A handler that throws has failed;
 * its message becomes the stage run's `reason`.
 */
export type StageOutcome = { status: "succeeded" } | { status: "skipped"; reason: string };

/**
 * One stage of the pipeline: intent, sections, review or CI. It reads what it
 * needs from the database and the ports, writes its own results, and reports
 * the outcome. It does not touch `stage_runs` or the change's status; the
 * pipeline does that around it.
 *
 * Handlers must be idempotent per attempt: Workflow steps are retried, so the
 * same attempt can run twice, and the second run must add nothing and pay for
 * nothing. A stage records which attempt produced a result (`Intent.attempt`,
 * `RevisionReview.attempt`) to tell a retry from a re-run a person asked for,
 * which is a new attempt.
 */
export type StageHandler<Deps> = (deps: Deps, input: StageInput) => Promise<StageOutcome>;

/**
 * What a change-pipeline Workflow instance is started with. The push trigger
 * delivers the raw Artifacts event instead of one of these; the Workflow tells
 * them apart by the absence of `kind` and parses that with `ArtifactsPushEvent`.
 */
export type PipelineParams =
  | { kind: "push"; push: Push }
  /**
   * `attempt` is the attempt the request queued (`StageRun.attempt`). An
   * instance runs that attempt and no other: if it has already settled, the
   * instance has nothing to do and must not queue another.
   */
  | { kind: "rerun"; changeId: ChangeId; stage: StageName; attempt: number };

/** What the CI Workflow is started with. */
export interface CiWorkflowParams extends StageInput {
  /** The pipeline instance waiting for the result. */
  notifyInstanceId: string;
}

/**
 * What the provisioning Workflow is started with: the slow work that must
 * not run on a request. Forking takes up to most of a minute and importing
 * can fail; preparing the workspace installs software in a container.
 */
export type ProvisionParams =
  | { kind: "fork"; sessionId: SessionId }
  | { kind: "import"; repositoryId: RepositoryId; url: string }
  | { kind: "workspace" };

/** The event type the CI Workflow sends back to the pipeline instance when it finishes. */
export const CI_FINISHED_EVENT = "ci-finished";

export type CiFinishedPayload = StageOutcome | { status: "failed"; reason: string };

/** Names shared by the Wrangler config, the Worker entry and the code that addresses them. */
export const workflowNames = {
  changePipeline: "gitflare-change-pipeline",
  ci: "gitflare-ci",
  provision: "gitflare-provision",
} as const;
