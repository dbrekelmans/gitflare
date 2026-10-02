// @gitflare/ci — ordinary CI for a change: read the repository's
// `.gitflare/ci.yml` at the head commit, check the head out in a sandbox, run
// the steps, record each step and stream its output. The CI Workflow in
// `apps/forge/src/server/workflows/ci.ts` drives these functions, one
// Workflow step per call, so each must be safe to run twice. Build task: `ci`.

export { parseCiConfig, planSteps } from "./config";
export {
  CHECKOUT_SCRIPT,
  CI_REGISTRY_HOSTS,
  CI_WORKDIR,
  type CiDeps,
  type CiStart,
  finishCiRun,
  pollCiStep,
  RUN_SCRIPT,
  readStepLog,
  type StartCiRunOptions,
  startCiRun,
  startCiStep,
} from "./run";
