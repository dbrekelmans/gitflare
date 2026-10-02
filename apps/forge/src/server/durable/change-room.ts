import { DurableObject } from "cloudflare:workers";
import type { ChangeEvent, ChangeId, TransientChangeSignal } from "@gitflare/core";
import type { LiveClientMessage, LiveServerMessage } from "@gitflare/core/api";
import { changeEventsAfter, schema } from "@gitflare/db";
import { createD1Db } from "@gitflare/db/d1";
import { eq } from "drizzle-orm";

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

function send(ws: WebSocket, message: LiveServerMessage): void {
  ws.send(JSON.stringify(message));
}

export class ChangeRoom extends DurableObject<Env> {
  /** The WebSocket upgrade, forwarded from `/api/changes/$changeId/live`. */
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected a WebSocket upgrade.", { status: 426 });
    }
    const changeId = changeIdFromUrl(request.url);
    if (!changeId) return new Response("No such change.", { status: 404 });

    const db = createD1Db(this.env.DB);
    const [row] = await db
      .select({ lastEventSeq: schema.changes.lastEventSeq })
      .from(schema.changes)
      .where(eq(schema.changes.id, changeId))
      .limit(1);

    const { 0: client, 1: server } = new WebSocketPair();
    server.serializeAttachment({ changeId } satisfies Attachment);
    this.ctx.acceptWebSocket(server);
    send(server, { type: "hello", changeId, lastSeq: row?.lastEventSeq ?? 0 });

    return new Response(null, { status: 101, webSocket: client });
  }

  /** A client asking to resume gets replayed everything after the sequence number it last saw. */
  async webSocketMessage(ws: WebSocket, message: ArrayBuffer | string): Promise<void> {
    if (typeof message !== "string") return;
    let parsed: LiveClientMessage;
    try {
      parsed = JSON.parse(message);
    } catch {
      return;
    }
    if (parsed.type !== "resume") return;
    const { changeId } = ws.deserializeAttachment() as Attachment;
    const db = createD1Db(this.env.DB);
    for (const event of await changeEventsAfter(db, changeId, parsed.after)) {
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
