import { z } from "zod";
import type {
  ChangeId,
  DecisionId,
  MessageId,
  RevisionId,
  SectionId,
  Sha,
  ThreadId,
  Timestamp,
  UserId,
} from "../ids";

/**
 * `comment`  something that must be settled before merge: a finding from the
 *            automatic review, or a reviewer's own comment
 * `chat`     a conversation with the agent about the change or one section;
 *            never blocks a merge
 */
export const ThreadKind = z.enum(["comment", "chat"]);
export type ThreadKind = z.infer<typeof ThreadKind>;

export const ThreadStatus = z.enum(["open", "resolved", "dismissed"]);
export type ThreadStatus = z.infer<typeof ThreadStatus>;

/**
 * Why a comment was dismissed. `not_a_problem` counts against that kind of
 * finding; `design_decision` is recorded as a decision for the repository.
 */
export const DismissalClass = z.enum(["not_a_problem", "design_decision"]);
export type DismissalClass = z.infer<typeof DismissalClass>;

export const FindingSeverity = z.enum(["blocking", "important", "minor"]);
export type FindingSeverity = z.infer<typeof FindingSeverity>;

export const FindingCategory = z.enum([
  "correctness",
  "design",
  "security",
  "performance",
  "tests",
  "intent",
  "decision_conflict",
]);
export type FindingCategory = z.infer<typeof FindingCategory>;

export interface Finding {
  category: FindingCategory;
  severity: FindingSeverity;
  title: string;
  /** Decisions the reviewing agent cited for this finding. */
  decisionIds: DecisionId[];
}

/** Where in the diff a comment points. Lines are on the head side unless `side` says otherwise. */
export const ThreadAnchor = z.object({
  path: z.string(),
  side: z.enum(["base", "head"]),
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
});
export type ThreadAnchor = z.infer<typeof ThreadAnchor>;

export interface Thread {
  id: ThreadId;
  changeId: ChangeId;
  /** Null for a change-level thread, and for a comment whose anchor matches no section yet. */
  sectionId: SectionId | null;
  kind: ThreadKind;
  /** `review` for the automatic review's findings; `human` for everything a person opened. */
  origin: "review" | "human";
  status: ThreadStatus;
  finding: Finding | null;
  anchor: ThreadAnchor | null;
  /** The revision the anchor's line numbers refer to. */
  anchorRevisionId: RevisionId | null;
  dismissal: DismissalClass | null;
  /** The decision recorded when the dismissal was a design decision. */
  decisionId: DecisionId | null;
  createdBy: UserId | null;
  createdAt: Timestamp;
  settledAt: Timestamp | null;
  settledBy: UserId | null;
  messageCount: number;
  lastMessageAt: Timestamp;
}

/** What the agent did as part of a reply, recorded on the message that did it. */
export type AgentAction =
  | { type: "resolved" }
  | { type: "dismissed"; classification: DismissalClass }
  | { type: "pushed_fix"; sha: Sha }
  | { type: "recorded_decision"; decisionId: DecisionId };

export interface ThreadMessage {
  id: MessageId;
  threadId: ThreadId;
  /** Order within the thread, from 1. */
  seq: number;
  author: { kind: "user"; userId: UserId } | { kind: "agent" };
  /** Markdown. */
  body: string;
  action: AgentAction | null;
  createdAt: Timestamp;
}
