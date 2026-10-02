import type { ChangeId, ThreadId, TransientChangeSignal } from "@gitflare/core";

export type LiveStatus = "connecting" | "live" | "offline";

// One connection per change, however many components listen. The page calls
// `useChangeLive` once; anything below it that wants the transient signals
// (a reply being typed, CI output) calls `useChangeSignal` or `useThreadDraft`
// and is fed from that same connection. Nothing opens a second socket.
//
// Build task: `live`. Until it lands these report `offline` and deliver
// nothing, and the page shows whatever its queries last fetched.

/**
 * Keeps a change's queries true while the page is open. It connects to the
 * change's live endpoint (`httpRoutes.changeLive`), and for each
 * `LiveServerMessage` carrying an event invalidates `keys.changes.one(changeId)`
 * (or the narrower key the event names), so components never handle events:
 * they read queries, and this makes those queries move. It reconnects with
 * backoff and resumes from the last sequence number it saw, starting at
 * `ChangeDetail.lastEventSeq`.
 */
export function useChangeLive(
  _changeId: ChangeId,
  _options?: { lastEventSeq?: number },
): { status: LiveStatus } {
  return { status: "offline" };
}

/**
 * Calls `onSignal` for every transient signal on the change's connection.
 * Signals are never stored: a component that mounts late has missed them, and
 * must be correct without them.
 */
export function useChangeSignal(
  _changeId: ChangeId,
  _onSignal: (signal: TransientChangeSignal) => void,
): void {}

/**
 * The agent's reply to a thread as it is being typed: the text so far, or
 * null when no reply is in flight. It goes back to null when the finished
 * message arrives through the thread query.
 */
export function useThreadDraft(_changeId: ChangeId, _threadId: ThreadId): string | null {
  return null;
}
