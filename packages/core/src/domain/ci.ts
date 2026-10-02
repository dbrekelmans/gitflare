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

export const CiConfig = z.object({
  /** Runs once in the fresh checkout, before any step. */
  setup: z.string().optional(),
  instance: z
    .enum(["lite", "standard-1", "standard-2", "standard-3", "standard-4"])
    .default("standard-2"),
  steps: z.array(CiStepConfig).min(1),
});
export type CiConfig = z.infer<typeof CiConfig>;

export const CiStatus = z.enum(["queued", "running", "succeeded", "failed", "cancelled"]);
export type CiStatus = z.infer<typeof CiStatus>;

export interface CiRun {
  id: CiRunId;
  changeId: ChangeId;
  revisionId: RevisionId;
  status: CiStatus;
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
