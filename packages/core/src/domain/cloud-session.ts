import { z } from "zod";
import type { SessionId, Timestamp } from "../ids";

/**
 * `starting`  the sandbox is booting and the fork is being checked out
 * `idle`      waiting for a prompt
 * `working`   the agent is running a turn
 * `asleep`    the sandbox was stopped; the workspace is in a snapshot or can be rebuilt from git
 * `ended`     the session is over (merged, abandoned, or stopped by its owner)
 * `failed`    it could not start or resume
 */
export const CloudSessionState = z.enum([
  "starting",
  "idle",
  "working",
  "asleep",
  "ended",
  "failed",
]);
export type CloudSessionState = z.infer<typeof CloudSessionState>;

export interface CloudSessionStatus {
  sessionId: SessionId;
  state: CloudSessionState;
  /** Set when `state` is `failed`. */
  error: string | null;
  updatedAt: Timestamp;
}

/** One thing the hosted agent did, in the order it happened. `seq` starts at 1. */
export type CloudSessionEvent = {
  sessionId: SessionId;
  seq: number;
  at: Timestamp;
} & (
  | { type: "prompt"; text: string }
  | { type: "assistant"; text: string }
  | { type: "tool"; name: string; summary: string }
  | { type: "pushed"; sha: string }
  | { type: "state"; state: CloudSessionState }
  | { type: "error"; message: string }
);
