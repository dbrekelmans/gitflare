import type { SessionStatus } from "../domain/repository";
import type { Section } from "../domain/section";
import type { DismissalClass, Thread, ThreadAnchor, ThreadStatus } from "../domain/thread";
import type { SectionId } from "../ids";
import { InvalidTransitionError } from "./change-status";

export type ThreadAction =
  | { type: "resolve" }
  | { type: "dismiss"; classification: DismissalClass }
  | { type: "reopen" }
  /** The author correcting what kind of dismissal it was. */
  | { type: "reclassify"; classification: DismissalClass };

export interface ThreadState {
  status: ThreadStatus;
  dismissal: DismissalClass | null;
}

/** Only comments are settled; a chat stays open for as long as the change does. */
export function transitionThread(
  thread: Pick<Thread, "kind" | "status" | "dismissal">,
  action: ThreadAction,
): ThreadState {
  const fail = () => new InvalidTransitionError("thread", thread.status, action.type);
  if (thread.kind === "chat") throw fail();
  switch (action.type) {
    case "resolve":
      if (thread.status !== "open") throw fail();
      return { status: "resolved", dismissal: null };
    case "dismiss":
      if (thread.status !== "open") throw fail();
      return { status: "dismissed", dismissal: action.classification };
    case "reopen":
      if (thread.status === "open") throw fail();
      return { status: "open", dismissal: null };
    case "reclassify":
      if (thread.status !== "dismissed") throw fail();
      return { status: "dismissed", dismissal: action.classification };
  }
}

/**
 * The section a comment belongs to: the first one, in reading order, that
 * presents the anchored file. Review and sectioning run in parallel, so a
 * finding is anchored to a file and lines first and placed in a section once
 * both exist.
 */
export function sectionForAnchor(
  sections: readonly Section[],
  anchor: Pick<ThreadAnchor, "path">,
): SectionId | null {
  const ordered = [...sections].sort((a, b) => a.position - b.position);
  return ordered.find((s) => s.files.some((f) => f.path === anchor.path))?.id ?? null;
}

export type SessionEvent = "merged" | "abandoned";

/** A session ends once, by its change merging or by being abandoned; its fork is deleted afterwards. */
export function transitionSession(status: SessionStatus, event: SessionEvent): SessionStatus {
  if (status !== "active") throw new InvalidTransitionError("session", status, event);
  return event;
}
