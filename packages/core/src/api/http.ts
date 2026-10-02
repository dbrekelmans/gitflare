import type { ChangeEvent, TransientChangeSignal } from "../domain/events";
import type { ChangeId } from "../ids";

/**
 * The forge's plain HTTP surface: what something other than the web app
 * calls. The web app itself uses server functions and never these.
 *
 * Bodies and responses are JSON. A failure is `{ error: { code, message } }`
 * with the status from `httpStatus(code)`.
 */
export const httpRoutes = {
  /** GET → `HealthResponse`. No authentication. */
  health: "/api/health",
  /** GET → `MeView`. The CLI uses it to confirm a login. */
  me: "/api/me",
  /** POST `GitCredentialInput` → `GitCredential`. Called by the git credential helper. */
  gitCredentials: "/api/git/credentials",
  /** GET → `RepositoryDetail`. */
  repository: (repoSlug: string) => `/api/repos/${repoSlug}`,
  /** POST `StartSessionInput` without `repoSlug` → `SessionView`. */
  repositorySessions: (repoSlug: string) => `/api/repos/${repoSlug}/sessions`,
  /** GET with `Upgrade: websocket`. Speaks `LiveServerMessage` / `LiveClientMessage`. */
  changeLive: (changeId: ChangeId) => `/api/changes/${changeId}/live`,
  /** POST `Push`. Exists only when the forge runs in local development. */
  devPush: "/api/dev/push",
} as const;

export interface HealthResponse {
  ok: true;
  mode: "dev" | "production";
}

export interface HttpErrorBody {
  error: { code: string; message: string };
}

/** First message on every live connection, then one per event or signal. */
export type LiveServerMessage =
  | { type: "hello"; changeId: ChangeId; lastSeq: number }
  | { type: "event"; event: ChangeEvent }
  | { type: "signal"; signal: TransientChangeSignal };

/**
 * A client that reconnects says where it left off; the server replays the
 * events after that sequence number from the change's log before going live.
 */
export type LiveClientMessage = { type: "resume"; after: number };
