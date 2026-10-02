import { env } from "cloudflare:workers";
import { createCapture } from "@gitflare/capture";
import { createIdGenerator, type Ports, systemClock } from "@gitflare/core/ports";
import type { Db } from "@gitflare/db";
import { createD1Db } from "@gitflare/db/d1";
import { createDecisionRecord } from "@gitflare/decisions";
import { createDiffs } from "@gitflare/diff";
import { createDemoPorts } from "@gitflare/testing";
import { createCloudflarePorts, type ExternalPorts } from "./adapters/cloudflare";
import { createChangeLive, createPipelineRunner, createThreadHost } from "./adapters/runtime";

/**
 * Everything server code works with: the database and every port. Domain
 * functions take the part of this they need (`Pick<Services, "db" | "git">`),
 * which is why a function written against it runs unchanged in a Node test
 * with `createTestDb()` and `createFakePorts()`.
 */
export interface Services extends Ports {
  db: Db;
  mode: "dev" | "production";
}

let services: Services | undefined;

function demoPorts(): ExternalPorts {
  const { git, gitWriter, models, identity, sandboxes, cloudSessions } = createDemoPorts();
  return { git, gitWriter, models, identity, sandboxes, cloudSessions };
}

/**
 * Builds a port the first time one of its methods is called, so a package
 * that is not built yet fails the operation that needs it, not the whole
 * Worker at start.
 */
function lazy<T extends object>(create: () => T): T {
  let instance: T | undefined;
  return new Proxy({} as T, {
    get(_target, property) {
      instance ??= create();
      const value = Reflect.get(instance, property);
      return typeof value === "function" ? value.bind(instance) : value;
    },
  });
}

/**
 * The composition root, and the only module besides the Durable Object and
 * Workflow shells that reads `env`. Built once per isolate.
 *
 * In local development the ports that would leave the machine (git host,
 * models, identity, containers, hosted sessions) are the fakes, loaded with
 * the demo; the database, live channel, pipeline, threads and gitflare's own
 * packages are the real ones, running locally.
 */
export function getServices(): Services {
  if (services) return services;
  // Anything but an explicit "dev" is production: a deployment with the
  // variable missing must never come up on fakes with a signed-in demo user.
  const mode = env.GITFLARE_MODE === "dev" ? "dev" : "production";
  const db = createD1Db(env.DB);
  const external: ExternalPorts = mode === "dev" ? demoPorts() : createCloudflarePorts(env, db);
  const clock = systemClock;
  const ids = createIdGenerator(clock);
  const { git, gitWriter, models } = external;
  services = {
    mode,
    db,
    ...external,
    // Gitflare's own packages, the same code locally and deployed.
    capture: lazy(() => createCapture({ db, git, clock })),
    diffs: lazy(() => createDiffs({ git })),
    decisions: lazy(() => createDecisionRecord({ db, git, gitWriter, models, clock, ids })),
    live: createChangeLive(env),
    pipeline: createPipelineRunner(env),
    threads: createThreadHost(env),
    clock,
    ids,
  };
  return services;
}
