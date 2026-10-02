import { z } from "zod";
import type { ChangeId, CiRunId, CiStepId, RevisionId, Timestamp } from "../ids";

/** Where a repository declares its CI: a data file gitflare reads, never code it executes itself. */
export const CI_CONFIG_PATH = ".gitflare/ci.yml";

export const CiStepConfig = z.object({
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9-]*$/),
  run: z.string().min(1),
  /** Names of steps that must succeed first. Steps with no unmet needs run in parallel. */
  needs: z.array(z.string()).default([]),
  timeoutMinutes: z.number().int().min(1).max(60).default(15),
});
export type CiStepConfig = z.infer<typeof CiStepConfig>;

/** A host name, or one with a leading `*.` for its subdomains. Never a bare `*`. */
export const EgressHost = z
  .string()
  .regex(
    /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i,
    "a host name",
  );

export const CiConfig = z.object({
  /** Runs once in the fresh checkout, before any step. */
  setup: z.string().optional(),
  instance: z
    .enum(["lite", "standard-1", "standard-2", "standard-3", "standard-4"])
    .default("standard-2"),
  /**
   * Hosts the run may fetch from besides the fork and gitflare's default
   * package registry: other registries, a toolchain download. Read-only.
   */
  egress: z.object({ hosts: z.array(EgressHost).max(20).default([]) }).default({ hosts: [] }),
  steps: z.array(CiStepConfig).min(1),
});
export type CiConfig = z.infer<typeof CiConfig>;

/**
 * `skipped` is a step that never ran because one it needs did not succeed;
 * `cancelled` is one stopped while queued or running.
 */
export const CiStatus = z.enum([
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "skipped",
]);
export type CiStatus = z.infer<typeof CiStatus>;

export interface CiRun {
  id: CiRunId;
  changeId: ChangeId;
  revisionId: RevisionId;
  status: CiStatus;
  /** Why the run failed when no step did: the workspace, the checkout or the setup command. */
  reason: string | null;
  startedAt: Timestamp | null;
  finishedAt: Timestamp | null;
}

export interface CiStep {
  id: CiStepId;
  runId: CiRunId;
  position: number;
  name: string;
  command: string;
  status: CiStatus;
  exitCode: number | null;
  startedAt: Timestamp | null;
  finishedAt: Timestamp | null;
  /** The last lines of output, kept with the record so a failure is readable without the sandbox. */
  logTail: string;
}
