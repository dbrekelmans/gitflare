import type { ChangeId, ThreadId, TransientChangeSignal } from "@gitflare/core";
import type { LiveClientMessage, LiveServerMessage } from "@gitflare/core/api";
import { httpRoutes } from "@gitflare/core/api";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { keys } from "./keys";

export type LiveStatus = "connecting" | "live" | "offline";

// One connection per change, however many components listen. The page calls
// `useChangeLive` once; anything below it that wants the transient signals
// (a reply being typed, CI output) calls `useChangeSignal` or `useThreadDraft`
// and is fed from that same connection. Nothing opens a second socket.

interface Connection {
  changeId: ChangeId;
  socket: WebSocket | null;
  status: LiveStatus;
  lastSeq: number;
  refCount: number;
  reconnectAttempt: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  statusListeners: Set<(status: LiveStatus) => void>;
  eventListeners: Set<(event: LiveServerMessage & { type: "event" }) => void>;
  signalListeners: Set<(signal: TransientChangeSignal) => void>;
  drafts: Map<ThreadId, string>;
  draftListeners: Map<ThreadId, Set<(text: string | null) => void>>;
}

const connections = new Map<ChangeId, Connection>();

function wsUrl(changeId: ChangeId): string {
  const path = httpRoutes.changeLive(changeId);
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}${path}`;
}

function setStatus(conn: Connection, status: LiveStatus): void {
  conn.status = status;
  for (const listener of conn.statusListeners) listener(status);
}

function setDraft(conn: Connection, threadId: ThreadId, text: string | null): void {
  if (text === null) conn.drafts.delete(threadId);
  else conn.drafts.set(threadId, text);
  for (const listener of conn.draftListeners.get(threadId) ?? []) listener(text);
}

function send(socket: WebSocket, message: LiveClientMessage): void {
  socket.send(JSON.stringify(message));
}

function connect(conn: Connection): void {
  setStatus(conn, "connecting");
  const socket = new WebSocket(wsUrl(conn.changeId));
  conn.socket = socket;

  socket.addEventListener("open", () => send(socket, { type: "resume", after: conn.lastSeq }));

  socket.addEventListener("message", (raw) => {
    const message = JSON.parse(raw.data as string) as LiveServerMessage;
    if (message.type === "hello") {
      conn.reconnectAttempt = 0;
      setStatus(conn, "live");
      return;
    }
    if (message.type === "event") {
      conn.lastSeq = Math.max(conn.lastSeq, message.event.seq);
      for (const listener of conn.eventListeners) listener(message);
      if (message.event.type === "thread.message") setDraft(conn, message.event.threadId, null);
      return;
    }
    for (const listener of conn.signalListeners) listener(message.signal);
    if (message.signal.type === "thread.delta") {
      setDraft(conn, message.signal.threadId, message.signal.text);
    }
  });

  socket.addEventListener("close", () => {
    if (conn.socket !== socket) return;
    conn.socket = null;
    setStatus(conn, "offline");
    if (conn.refCount <= 0) return;
    conn.reconnectAttempt += 1;
    const delay = Math.min(30_000, 1_000 * 2 ** (conn.reconnectAttempt - 1));
    conn.reconnectTimer = setTimeout(() => connect(conn), delay);
  });

  socket.addEventListener("error", () => socket.close());
}

function acquire(changeId: ChangeId, lastEventSeq?: number): Connection {
  let conn = connections.get(changeId);
  if (!conn) {
    conn = {
      changeId,
      socket: null,
      status: "connecting",
      lastSeq: lastEventSeq ?? 0,
      refCount: 0,
      reconnectAttempt: 0,
      reconnectTimer: null,
      statusListeners: new Set(),
      eventListeners: new Set(),
      signalListeners: new Set(),
      drafts: new Map(),
      draftListeners: new Map(),
    };
    connections.set(changeId, conn);
  } else if (lastEventSeq !== undefined) {
    conn.lastSeq = Math.max(conn.lastSeq, lastEventSeq);
  }
  conn.refCount += 1;
  if (!conn.socket) {
    // A hook can mount while a dropped connection's reconnect is still
    // pending; connect now and cancel that timer so it never fires a second,
    // leaked socket once this one is open.
    if (conn.reconnectTimer) {
      clearTimeout(conn.reconnectTimer);
      conn.reconnectTimer = null;
    }
    connect(conn);
  }
  return conn;
}

function release(conn: Connection): void {
  conn.refCount -= 1;
  if (conn.refCount > 0) return;
  if (conn.reconnectTimer) clearTimeout(conn.reconnectTimer);
  conn.socket?.close();
  connections.delete(conn.changeId);
}

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
  changeId: ChangeId,
  options?: { lastEventSeq?: number },
): { status: LiveStatus } {
  const queryClient = useQueryClient();
  const [status, setStatusState] = useState<LiveStatus>("connecting");
  const lastEventSeqRef = useRef(options?.lastEventSeq);
  lastEventSeqRef.current = options?.lastEventSeq;

  useEffect(() => {
    const conn = acquire(changeId, lastEventSeqRef.current);
    setStatusState(conn.status);
    const onStatus = (next: LiveStatus) => setStatusState(next);
    const onEvent = () => queryClient.invalidateQueries({ queryKey: keys.changes.one(changeId) });
    conn.statusListeners.add(onStatus);
    conn.eventListeners.add(onEvent);
    return () => {
      conn.statusListeners.delete(onStatus);
      conn.eventListeners.delete(onEvent);
      release(conn);
    };
  }, [changeId, queryClient]);

  return { status };
}

/**
 * Calls `onSignal` for every transient signal on the change's connection.
 * Signals are never stored: a component that mounts late has missed them, and
 * must be correct without them.
 */
export function useChangeSignal(
  changeId: ChangeId,
  onSignal: (signal: TransientChangeSignal) => void,
): void {
  const onSignalRef = useRef(onSignal);
  onSignalRef.current = onSignal;

  useEffect(() => {
    const conn = acquire(changeId);
    const listener = (signal: TransientChangeSignal) => onSignalRef.current(signal);
    conn.signalListeners.add(listener);
    return () => {
      conn.signalListeners.delete(listener);
      release(conn);
    };
  }, [changeId]);
}

/**
 * The agent's reply to a thread as it is being typed: the text so far, or
 * null when no reply is in flight. It goes back to null when the finished
 * message arrives through the thread query.
 */
export function useThreadDraft(changeId: ChangeId, threadId: ThreadId): string | null {
  const [draft, setDraftState] = useState<string | null>(null);

  useEffect(() => {
    const conn = acquire(changeId);
    setDraftState(conn.drafts.get(threadId) ?? null);
    const listeners = conn.draftListeners.get(threadId) ?? new Set();
    conn.draftListeners.set(threadId, listeners);
    const listener = (text: string | null) => setDraftState(text);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      release(conn);
    };
  }, [changeId, threadId]);

  return draft;
}
