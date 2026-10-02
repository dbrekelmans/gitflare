import type { ChangeId } from "@gitflare/core";

export type LiveStatus = "connecting" | "live" | "offline";

/**
 * Keeps a change's queries true while the page is open. It connects to the
 * change's live endpoint (`httpRoutes.changeLive`), and for each
 * `LiveServerMessage` invalidates `keys.changes.one(changeId)` (or the
 * narrower key the event names), so components never handle events
 * themselves: they read queries, and this hook makes those queries move.
 * Transient signals (a reply being typed, CI output) are exposed through
 * `onSignal`. It reconnects with backoff and resumes from the last sequence
 * number it saw, starting at `ChangeDetail.lastEventSeq`.
 *
 * Build task: `live`. Until it lands this reports `offline` and the page
 * shows whatever its queries last fetched.
 */
export function useChangeLive(
  _changeId: ChangeId,
  _options?: {
    lastEventSeq?: number;
    onSignal?: (signal: import("@gitflare/core").TransientChangeSignal) => void;
  },
): { status: LiveStatus } {
  return { status: "offline" };
}
