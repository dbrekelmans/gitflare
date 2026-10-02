import { DurableObject } from "cloudflare:workers";
import type { ChangeEvent, ChangeId, TransientChangeSignal } from "@gitflare/core";
import type { LiveClientMessage, LiveServerMessage } from "@gitflare/core/api";
import { changeEventsAfter, changeLastEventSeq } from "@gitflare/db";
import { getServices } from "../services";

/**
 * One per change, named by change id: the browsers watching that change.
 * It accepts their WebSockets with the hibernation API, replays what a
 * reconnecting client missed from the change's event log, and fans out each
 * new event and signal. It stores nothing of its own; the log in D1 is the
 * record. Protocol: `LiveServerMessage` / `LiveClientMessage` in
 * `@gitflare/core/api`. Build task: `live`.
 */

interface Attachment {
  changeId: ChangeId;
}

function changeIdFromUrl(url: string): ChangeId | null {
  const match = /\/api\/changes\/([^/]+)\/live$/.exec(new URL(url).pathname);
  return (match?.[1] as ChangeId | undefined) ?? null;
}

function isResumeMessage(value: unknown): value is LiveClientMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "resume" &&
    typeof (value as { after?: unknown }).after === "number"
  );
}

function send(ws: WebSocket, message: LiveServerMessage): void {
  try {
    ws.send(JSON.stringify(message));
  } catch {
    // A closing or broken socket must not stop the others from hearing it.
  }
}

export class ChangeRoom extends DurableObject<Env> {
  /** The WebSocket upgrade, forwarded from `/api/changes/$changeId/live`. */
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected a WebSocket upgrade.", { status: 426 });
    }
    const changeId = changeIdFromUrl(request.url);
    if (!changeId) return new Response("No such change.", { status: 404 });

    const lastSeq = await changeLastEventSeq(getServices().db, changeId);
    if (lastSeq === null) return new Response("No such change.", { status: 404 });

    const { 0: client, 1: server } = new WebSocketPair();
    server.serializeAttachment({ changeId } satisfies Attachment);
    this.ctx.acceptWebSocket(server);
    send(server, { type: "hello", changeId, lastSeq });

    return new Response(null, { status: 101, webSocket: client });
  }

  /** A client asking to resume gets replayed everything after the sequence number it last saw. */
  async webSocketMessage(ws: WebSocket, message: ArrayBuffer | string): Promise<void> {
    if (typeof message !== "string") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(message);
    } catch {
      return;
    }
    if (!isResumeMessage(parsed)) return;
    const { changeId } = ws.deserializeAttachment() as Attachment;
    for (const event of await changeEventsAfter(getServices().db, changeId, parsed.after)) {
      send(ws, { type: "event", event });
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    ws.close(code, reason);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    ws.close(1011, "error");
  }

  async publish(event: ChangeEvent): Promise<void> {
    for (const ws of this.ctx.getWebSockets()) send(ws, { type: "event", event });
  }

  async signal(_changeId: ChangeId, signal: TransientChangeSignal): Promise<void> {
    for (const ws of this.ctx.getWebSockets()) send(ws, { type: "signal", signal });
  }
}
