import { z } from "zod";
import type {
  ChangeId,
  DecisionEventId,
  DecisionId,
  RepositoryId,
  ThreadId,
  Timestamp,
  UserId,
} from "../ids";

export const DecisionStatus = z.enum(["active", "dormant"]);
export type DecisionStatus = z.infer<typeof DecisionStatus>;

export const DecisionOrigin = z.enum([
  "dismissed_finding",
  "review_reply",
  "chat",
  "change",
  "manual",
]);
export type DecisionOrigin = z.infer<typeof DecisionOrigin>;

/**
 * Something this repository has decided about how it is built, recorded from
 * the review of a change rather than written up by hand. It behaves like a
 * memory: `strength` moves when later work follows or contradicts it, and
 * below a threshold it goes dormant. It is never deleted.
 */
export interface Decision {
  id: DecisionId;
  repositoryId: RepositoryId;
  /** Path of the decision's file in the context repo, e.g. `decisions/retry-with-backoff.md`. */
  path: string;
  title: string;
  /** The rule, as one or two sentences. */
  statement: string;
  rationale: string;
  /**
   * Decisions are general rules. A path glob is the exception, set only when a
   * person asks for it; the file disappearing does not retire the decision.
   */
  scope: { kind: "general" } | { kind: "paths"; globs: string[] };
  status: DecisionStatus;
  /** 0 to 1. See `machines/decision-strength.ts`. */
  strength: number;
  origin: DecisionOrigin;
  originChangeId: ChangeId | null;
  originThreadId: ThreadId | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

/** A decision's whole wording: what an edit changes and what a revert puts back. */
export interface DecisionWording {
  title: string;
  statement: string;
  rationale: string;
}

/** The wording of a decision, or of anything shaped like one. */
export function decisionWording(source: DecisionWording): DecisionWording {
  return { title: source.title, statement: source.statement, rationale: source.rationale };
}

export function sameWording(a: DecisionWording, b: DecisionWording): boolean {
  return a.title === b.title && a.statement === b.statement && a.rationale === b.rationale;
}

function globPattern(glob: string): RegExp {
  let pattern = "";
  for (let i = 0; i < glob.length; i++) {
    const char = glob.charAt(i);
    if (char !== "*") {
      pattern += char.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
    } else if (glob.charAt(i + 1) !== "*") {
      pattern += "[^/]*";
    } else {
      i++;
      // `**/` also matches no directory at all: `src/**/x.ts` covers `src/x.ts`.
      if (glob.charAt(i + 1) === "/") {
        i++;
        pattern += "(?:.*/)?";
      } else {
        pattern += ".*";
      }
    }
  }
  return new RegExp(`^${pattern}$`);
}

/**
 * Whether a decision bears on a change that touches `paths`. A general rule
 * always does. One tied to paths does when a glob matches a path: `*` stays
 * inside one directory, `**` crosses them, and a glob ending in `/` covers
 * everything beneath it.
 */
export function decisionApplies(scope: Decision["scope"], paths: readonly string[]): boolean {
  if (scope.kind === "general") return true;
  const patterns = scope.globs.map((glob) => globPattern(glob.endsWith("/") ? `${glob}**` : glob));
  return paths.some((path) => patterns.some((pattern) => pattern.test(path)));
}

export const DecisionEventKind = z.enum([
  "created",
  "followed",
  "cited",
  "confirmed",
  "contradiction_accepted",
  "reshaped",
  "reverted",
  "revived",
]);
export type DecisionEventKind = z.infer<typeof DecisionEventKind>;

/** Why a decision's strength or wording is what it is. The UI shows these; a person can revert one. */
export interface DecisionEvent {
  id: DecisionEventId;
  decisionId: DecisionId;
  kind: DecisionEventKind;
  changeId: ChangeId | null;
  threadId: ThreadId | null;
  userId: UserId | null;
  strengthBefore: number;
  strengthAfter: number;
  /**
   * Set when the event changed the wording (`reshaped`, `reverted`): all of
   * it, as it was and as it became, so a revert restores the title and the
   * rationale with the statement. `before` and `after` always differ: an edit
   * that changes nothing records no event.
   */
  wording: { before: DecisionWording; after: DecisionWording } | null;
  note: string | null;
  createdAt: Timestamp;
}

/** How a change related to a decision it was reviewed against. Settled into events at merge. */
export const DecisionRelation = z.enum(["retrieved", "followed", "cited", "contradicted"]);
export type DecisionRelation = z.infer<typeof DecisionRelation>;

export interface ChangeDecisionLink {
  changeId: ChangeId;
  decisionId: DecisionId;
  relation: DecisionRelation;
  /** Cosine similarity at retrieval, 0 to 1. */
  similarity: number;
  threadId: ThreadId | null;
}
