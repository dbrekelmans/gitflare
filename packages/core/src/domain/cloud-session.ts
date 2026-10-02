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

/**
 * A hosted session's first prompt, kept from the request that starts the
 * session until its fork exists. The provisioning step that completes the
 * fork hands it to `CloudSessions.launch` and sets `launchedAt`; a launch
 * with `launchedAt` set has been delivered and is never sent again.
 */
export interface SessionLaunch {
  sessionId: SessionId;
  prompt: string;
  requestedAt: Timestamp;
  launchedAt: Timestamp | null;
}

/**
 * One thing the hosted agent did, in the order it happened. `seq` starts at 1
 * and keeps counting across a stop and a resume. An `assistant` event is one
 * complete block of the agent's reply, never a partial one to append to.
 */
export type CloudSessionEventBody =
  | { type: "prompt"; text: string }
  | { type: "assistant"; text: string }
  | { type: "tool"; name: string; summary: string }
  | { type: "pushed"; sha: string }
  | { type: "state"; state: CloudSessionState }
  | { type: "error"; message: string };

export type CloudSessionEvent = {
  sessionId: SessionId;
  seq: number;
  at: Timestamp;
} & CloudSessionEventBody;
