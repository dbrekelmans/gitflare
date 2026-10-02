import type { GitHost, GitWriter } from "./git";
import type { CapturePort, DecisionsPort, DiffPort } from "./internal";
import type { ModelGateway } from "./models";
import type {
  ChangeLive,
  Clock,
  CloudSessions,
  IdentityProvider,
  IdGenerator,
  PipelineRunner,
  ThreadHost,
} from "./runtime";
import type { SandboxHost } from "./sandbox";

export * from "./git";
export * from "./internal";
export * from "./models";
export * from "./runtime";
export * from "./sandbox";
export * from "./system";

/**
 * Everything a domain function reaches beyond its own code and the database:
 * the services outside the Worker, the Worker's own Durable Objects and
 * Workflows, and the three internal ports. Domain functions take
 * the ports they use (`Pick<Ports, "git" | "models">`), production wires the
 * Cloudflare adapters, and tests and local development wire the fakes from
 * `@gitflare/testing`.
 */
export interface Ports {
  git: GitHost;
  gitWriter: GitWriter;
  sandboxes: SandboxHost;
  models: ModelGateway;
  identity: IdentityProvider;
  live: ChangeLive;
  pipeline: PipelineRunner;
  threads: ThreadHost;
  cloudSessions: CloudSessions;
  capture: CapturePort;
  diffs: DiffPort;
  decisions: DecisionsPort;
  clock: Clock;
  ids: IdGenerator;
}
