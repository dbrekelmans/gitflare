import type {
  ChangeId,
  CiStepId,
  RevisionId,
  SectionId,
  ThreadId,
  Timestamp,
  UserId,
} from "../ids";
import type { ChangeStatus, StageName, StageStatus } from "./change";
import type { CiStatus } from "./ci";
import type { ThreadStatus } from "./thread";

/**
 * Everything that happens to a change after it opens. Each event is appended
 * to the change's log with the next sequence number and then broadcast to the
 * browsers watching it. An event says what changed, not the new state: clients
 * refetch the queries it touches.
 */
export type ChangeEventBody =
  | { type: "change.status"; status: ChangeStatus }
  | { type: "revision.pushed"; revisionId: RevisionId; number: number }
  | {
      type: "stage.status";
      stage: StageName;
      attempt: number;
      status: StageStatus;
      reason: string | null;
    }
  | { type: "intent.updated" }
  | { type: "sections.updated" }
  | { type: "section.approved"; sectionId: SectionId; userId: UserId }
  | { type: "section.approval_withdrawn"; sectionId: SectionId; userId: UserId }
  | { type: "thread.opened"; threadId: ThreadId }
  | { type: "thread.message"; threadId: ThreadId; seq: number }
  | { type: "thread.status"; threadId: ThreadId; status: ThreadStatus }
  | { type: "ci.step"; stepId: CiStepId; name: string; status: CiStatus }
  | { type: "change.merged"; mergeSha: string; userId: UserId };

export type ChangeEvent = ChangeEventBody & {
  changeId: ChangeId;
  /** Gap-free and increasing per change, from 1. A client resumes from the last one it saw. */
  seq: number;
  at: Timestamp;
};

/**
 * Sent only to connected browsers and never stored: a reply being typed out by
 * the agent, and CI output as it is produced.
 */
export type TransientChangeSignal =
  | { type: "thread.delta"; threadId: ThreadId; text: string }
  | { type: "ci.log"; stepId: CiStepId; text: string };
