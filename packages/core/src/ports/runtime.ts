import type { StageName } from "../domain/change";
import type { CloudSessionEvent, CloudSessionStatus } from "../domain/cloud-session";
import type { ChangeEvent, TransientChangeSignal } from "../domain/events";
import type { Identity } from "../domain/organisation";
import type { Push } from "../domain/push";
import type { AgentAction, ThreadMessage } from "../domain/thread";
import type { ChangeId, Id, IdKind, SessionId, ThreadId, Timestamp, UserId } from "../ids";

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
  /** Queues a new attempt of one settled stage for the change's head revision. */
  rerunStage(changeId: ChangeId, stage: StageName): Promise<void>;
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

/** A hosted session's sandbox and agent, addressed by session. */
export interface CloudSessions {
  /** Boots the workspace for a session whose fork already exists, and sends the first prompt. */
  launch(sessionId: SessionId, prompt: string): Promise<void>;
  prompt(sessionId: SessionId, text: string): Promise<void>;
  status(sessionId: SessionId): Promise<CloudSessionStatus>;
  /** Events with `seq` greater than `after`, oldest first. */
  events(sessionId: SessionId, after: number): Promise<CloudSessionEvent[]>;
  /** Stops the sandbox. The fork and everything pushed to it stay. */
  stop(sessionId: SessionId): Promise<void>;
}
