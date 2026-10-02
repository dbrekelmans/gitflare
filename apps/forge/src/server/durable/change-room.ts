import { DurableObject } from "cloudflare:workers";
import type { ChangeEvent, ChangeId, TransientChangeSignal } from "@gitflare/core";
import { notImplemented } from "@gitflare/core";

/**
 * One per change, named by change id: the browsers watching that change.
 * It accepts their WebSockets with the hibernation API, replays what a
 * reconnecting client missed from the change's event log, and fans out each
 * new event and signal. It stores nothing of its own; the log in D1 is the
 * record. Protocol: `LiveServerMessage` / `LiveClientMessage` in
 * `@gitflare/core/api`. Build task: `live`.
 */
export class ChangeRoom extends DurableObject<Env> {
  /** The WebSocket upgrade, forwarded from `/api/changes/$changeId/live`. */
  async fetch(_request: Request): Promise<Response> {
    return new Response("not implemented: ChangeRoom.fetch", { status: 501 });
  }

  async publish(_event: ChangeEvent): Promise<void> {
    return notImplemented("ChangeRoom.publish");
  }

  async signal(_changeId: ChangeId, _signal: TransientChangeSignal): Promise<void> {
    return notImplemented("ChangeRoom.signal");
  }
}
