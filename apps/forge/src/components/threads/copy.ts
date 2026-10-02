import type { AgentAction, DismissalClass, Thread, ThreadAnchor } from "@gitflare/core";
import type { ThreadView } from "@gitflare/core/api";
import type { StatusTone } from "@gitflare/ui/components/status";
import { shortSha } from "@/lib/format";

// What a thread says about each of its states, kept apart from the components
// so the wording of a state is in one place.

/** The name the agent's turns carry. */
export const AGENT_NAME = "gitflare";

export function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** An open comment is the one thing here that waits on a person. */
export const statusCopy: Record<Thread["status"], { label: string; tone: StatusTone }> = {
  open: { label: "Open", tone: "flare" },
  resolved: { label: "Resolved", tone: "success" },
  dismissed: { label: "Dismissed", tone: "neutral" },
};

export const dismissalCopy: Record<
  DismissalClass,
  { label: string; as: string; consequence: string }
> = {
  not_a_problem: {
    label: "Not a problem",
    as: "as not a problem",
    consequence: "Counts against raising this kind of finding again.",
  },
  design_decision: {
    label: "A design decision",
    as: "as a design decision",
    consequence: "Recorded as a decision that later reviews of this repository are given.",
  },
};

export function otherDismissal(classification: DismissalClass): DismissalClass {
  return classification === "not_a_problem" ? "design_decision" : "not_a_problem";
}

/** `src/a.ts:12–19`, as the review recorded it. */
export function anchorCopy(anchor: ThreadAnchor): string {
  const lines =
    anchor.startLine === anchor.endLine
      ? `${anchor.startLine}`
      : `${anchor.startLine}–${anchor.endLine}`;
  return `${anchor.path}:${lines}${anchor.side === "base" ? " (before)" : ""}`;
}

/** What the agent did with a reply, as the record has it. */
export function actionCopy(action: AgentAction): string {
  switch (action.type) {
    case "resolved":
      return "resolved this comment";
    case "dismissed":
      return `dismissed ${dismissalCopy[action.classification].as}`;
    case "pushed_fix":
      return `pushed fix ${shortSha(action.sha)}`;
    case "recorded_decision":
      return "recorded a decision";
  }
}

/** What a thread is called: its finding, or for a person's thread how it began. */
export function threadTitle({ thread, messages }: ThreadView): string {
  if (thread.finding) return thread.finding.title;
  const first = messages[0];
  if (!first) return thread.kind === "chat" ? "A chat" : "A comment";
  const text = first.body.replace(/\s+/g, " ").trim();
  return text.length > 96 ? `${text.slice(0, 95).trimEnd()}…` : text;
}

/** Who settled a comment, when the thread's own messages say who that is. */
export function settledByName({ thread, messages }: ThreadView): string | null {
  if (thread.status === "open") return null;
  if (thread.settledBy === null) return AGENT_NAME;
  return messages.find((message) => message.user?.id === thread.settledBy)?.user?.name ?? null;
}

/** Open comments first, since they block the merge; then chats; then what is settled. Oldest first within each. */
export function inReadingOrder(threads: ThreadView[]): ThreadView[] {
  const rank = ({ thread }: ThreadView) =>
    thread.status !== "open" ? 2 : thread.kind === "comment" ? 0 : 1;
  return [...threads].sort((a, b) => rank(a) - rank(b) || a.thread.createdAt - b.thread.createdAt);
}
