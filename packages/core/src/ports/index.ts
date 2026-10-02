import type { GitHost, GitWriter } from "./git";
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
export * from "./models";
export * from "./runtime";
export * from "./sandbox";

/**
 * Everything outside gitflare's own code and database. Domain functions take
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
  clock: Clock;
  ids: IdGenerator;
}
