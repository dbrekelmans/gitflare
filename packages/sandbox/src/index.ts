// @gitflare/sandbox — one container, driven through the Durable Object that
// owns it. Sandbox SDK 1.0 is helpers, not a sandbox: starting the container,
// running commands, keeping it alive, snapshots and egress are all this
// package's code over `ctx.container`. The Durable Object class in
// `apps/forge/src/server/durable/sandbox-room.ts` is a thin shell around
// `SandboxController`; everything testable lives here, against `ContainerLike`.
// Facts and signatures: spec/research/sandbox-ci.md, and what a real account
// did: spec/research/live/container-git.md. Build task: `sandbox`.

export {
  type ContainerLike,
  type ContainerStart,
  type ExecProcessLike,
  noContainer,
} from "./container";
export {
  type ControllerStorage,
  SandboxController,
  type SandboxControllerOptions,
} from "./controller";
export {
  createGitTokenCache,
  decideEgress,
  type EgressCredential,
  type EgressDecision,
  type EgressDeps,
  type EgressMode,
  type EgressProps,
  type EgressTargets,
  egressMode,
  forwardEgress,
  type ModelEgressCall,
  resolveEgressTargets,
} from "./egress";
export { createSandboxHost, type SandboxStub } from "./host";
export { type PrepareWorkspaceOptions, prepareWorkspace } from "./workspace";
