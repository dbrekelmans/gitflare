import { type CloudSessionEvent, notImplemented, type SessionId } from "@gitflare/core";
import type { Clock, CloudSessions, GitHost, SandboxHost } from "@gitflare/core/ports";
import type { Db } from "@gitflare/db";

// @gitflare/sessions — hosted sessions: the same coding agent a developer runs
// locally, in a sandbox on the deployment's own account. The workspace image
// carries the agent and the capture client with hooks installed, so a cloud
// session produces the same commits, trailers and checkpoints as a local one
// and everything after the push is identical. Model calls and git leave the
// sandbox only through egress grants. Build task: `cloud-sessions`.

export interface SessionsDeps {
  db: Db;
  git: GitHost;
  sandboxes: SandboxHost;
  clock: Clock;
}

/** The `CloudSessions` port over sandboxes. State and the event log live in the session's sandbox. */
export function createCloudSessions(_deps: SessionsDeps): CloudSessions {
  return notImplemented("@gitflare/sessions createCloudSessions");
}

/**
 * Turns the agent's own event stream (one JSON object per line) into session
 * events. Lines it does not understand are skipped: the file is written by
 * code running in the sandbox and is not trusted.
 */
export function parseAgentEvents(
  _sessionId: SessionId,
  _jsonl: string,
  _after: number,
): CloudSessionEvent[] {
  return notImplemented("@gitflare/sessions parseAgentEvents");
}

/** The command line and environment the agent is started with for one prompt. */
export function agentCommand(_input: { prompt: string; model: string; gatewayBaseUrl: string }): {
  command: string[];
  env: Record<string, string>;
} {
  return notImplemented("@gitflare/sessions agentCommand");
}
