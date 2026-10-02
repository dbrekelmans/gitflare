import type { StageName } from "../domain/change";
import type { CloudSessionEvent, CloudSessionStatus } from "../domain/cloud-session";
import type { ChangeEvent, TransientChangeSignal } from "../domain/events";
import type { Identity } from "../domain/organisation";
import type { Push } from "../domain/push";
import type { AgentAction, ThreadMessage } from "../domain/thread";
import type {
  ChangeId,
  Id,
  IdKind,
  RepositoryId,
  SessionId,
  ThreadId,
  Timestamp,
  UserId,
} from "../ids";

/** "Who is this request from": the one function a different identity system would replace. */
export interface IdentityProvider {
  /** Null when the request carries no valid identity. Never throws for a bad token. */
  identify(headers: { get(name: string): string | null }): Promise<Identity | null>;
}

export interface Clock {
  now(): Timestamp;
}

export interface IdGenerator {
  next<K extends IdKind>(kind: K): Id<K>;
}

/** Fan-out to the browsers watching one change. Delivery is best-effort; the event log is the record. */
export interface ChangeLive {
  publish(event: ChangeEvent): Promise<void>;
  signal(changeId: ChangeId, signal: TransientChangeSignal): Promise<void>;
}

/** Starts and re-enters the change pipeline. In production these create Workflow instances. */
export interface PipelineRunner {
  /** What the push trigger does. Exposed so local development and tests can raise a push by hand. */
  handlePush(push: Push): Promise<void>;
  /**
   * Runs one attempt of one stage that a request has already queued for the
   * change's head revision. Asking twice for the same attempt runs it once.
   */
  rerunStage(changeId: ChangeId, stage: StageName, attempt: number): Promise<void>;
}

/**
 * Starts slow work in the background and returns at once. In production each
 * call creates a provisioning Workflow instance. The caller records the thing
 * as not ready (`Session.forkReadyAt`, `Repository.readyAt`, a null workspace
 * snapshot); the Workflow marks it ready when the work is done, or records
 * that it failed for good (`Repository.importFailedAt`, a `failed` workspace
 * preparation) so that nothing waits on it forever.
 */
export interface Provisioner {
  /** Forks the repository for a session and, for a cloud session, launches it once the fork exists. */
  forkSession(sessionId: SessionId): Promise<void>;
  importRepository(repositoryId: RepositoryId, url: string): Promise<void>;
  prepareWorkspace(): Promise<void>;
}

export interface NewThreadMessage {
  author: { kind: "user"; userId: UserId } | { kind: "agent" };
  body: string;
  action?: AgentAction;
}

/**
 * The single writer for a thread's conversation. It appends in order, writes
 * each message through to the database, announces it on the change's live
 * channel, and — for a person's message on a thread the agent takes part in —
 * runs the agent's turn. One thread never runs two turns at once.
 */
export interface ThreadHost {
  post(threadId: ThreadId, message: NewThreadMessage): Promise<ThreadMessage>;
}

/**
 * A hosted session's sandbox and agent, addressed by session.
 *
 * Starting one takes two steps, because a fork takes up to most of a minute.
 * The request that starts the session (`sessions.start`) records the session
 * and its first prompt as a `SessionLaunch`, asks for the fork, and returns;
 * it does not call this port. The provisioning step that completes the fork
 * then calls `launch` with that prompt and marks the launch delivered.
 * Nothing else calls `launch`.
 */
export interface CloudSessions {
  /**
   * Boots the workspace and sends the first prompt. Only for a session whose
   * fork exists: it throws `not_ready` otherwise and never waits for one.
   * Safe to call twice: a session that was already launched is left alone,
   * and its prompt is not sent again.
   */
  launch(sessionId: SessionId, prompt: string): Promise<void>;
  /** Throws `not_ready` until the session has been launched. */
  prompt(sessionId: SessionId, text: string): Promise<void>;
  status(sessionId: SessionId): Promise<CloudSessionStatus>;
  /** Events with `seq` greater than `after`, oldest first. They outlive the sandbox. */
  events(sessionId: SessionId, after: number): Promise<CloudSessionEvent[]>;
  /**
   * Stops the sandbox. The fork and everything pushed to it stay. Ending a
   * session (`endSession`) calls this too, so no sandbox outlives its session.
   */
  stop(sessionId: SessionId): Promise<void>;
}
