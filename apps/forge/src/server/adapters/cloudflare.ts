import { notImplemented } from "@gitflare/core";
import type { Ports } from "@gitflare/core/ports";
import type { Db } from "@gitflare/db";

/** The ports that reach outside the Worker: the ones local development replaces with fakes. */
export type ExternalPorts = Pick<
  Ports,
  "git" | "gitWriter" | "models" | "identity" | "sandboxes" | "cloudSessions"
>;

/**
 * Production wiring: Artifacts for git, the AI binding behind the gateway for
 * models, Access for identity, the sandbox Durable Object for containers.
 * Each adapter is built and tested in its own package; this function only
 * assembles them from `env`. Build task: `integration`.
 */
export function createCloudflarePorts(_env: Env, _db: Db): ExternalPorts {
  return notImplemented("createCloudflarePorts");
}
