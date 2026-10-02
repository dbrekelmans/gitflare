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
 *
 * No body may have a field named `changeId`, `seq` or `at`: those are the
 * envelope's (`ChangeEvent`) and would be overwritten by it.
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
  /** `messageSeq` is the message's own order in its thread (`ThreadMessage.seq`), not the event's. */
  | { type: "thread.message"; threadId: ThreadId; messageSeq: number }
  | { type: "thread.status"; threadId: ThreadId; status: ThreadStatus }
  | { type: "ci.step"; stepId: CiStepId; name: string; status: CiStatus }
  | { type: "change.merged"; mergeSha: string; userId: UserId };

// Fails to compile when a body declares one of the envelope's fields.
type EnvelopeClash = Extract<
  ChangeEventBody,
  { changeId: unknown } | { seq: unknown } | { at: unknown }
>;
const _noBodyShadowsTheEnvelope: EnvelopeClash extends never ? true : never = true;
void _noBodyShadowsTheEnvelope;

export type ChangeEvent = ChangeEventBody & {
  changeId: ChangeId;
  /** Gap-free and increasing per change, from 1. A client resumes from the last one it saw. */
  seq: number;
  at: Timestamp;
};

/**
 * Sent only to connected browsers and never stored: a reply being typed out by
 * the agent, and CI output as it is produced. `thread.delta.text` is the
 * reply so far in full (cumulative), not an increment to append. A draft ends
 * in one of two ways: its message arrives as a `thread.message` event, or the
 * turn failed or was restarted and `thread.draft_discarded` says to drop it.
 */
export type TransientChangeSignal =
  | { type: "thread.delta"; threadId: ThreadId; text: string }
  | { type: "thread.draft_discarded"; threadId: ThreadId }
  | { type: "ci.log"; stepId: CiStepId; text: string };
