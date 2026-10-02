import type { LiveServerMessage } from "@gitflare/core/api";

/**
 * Stands in for a browser `WebSocket` in tests of what the live connection
 * feeds: records what was sent, and lets a test play the server's part.
 * Install it with `vi.stubGlobal("WebSocket", FakeWebSocket)`.
 */
export class FakeWebSocket extends EventTarget {
  static instances: FakeWebSocket[] = [];
  readonly url: string;
  readonly sent: string[] = [];
  closed = false;

  constructor(url: string) {
    super();
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  /** The socket a page has open for a change, already past its handshake. */
  static serving(changeId: string): FakeWebSocket {
    const socket = FakeWebSocket.instances.findLast(
      (candidate) => !candidate.closed && candidate.url.includes(changeId),
    );
    if (!socket) throw new Error(`no live connection is open for ${changeId}`);
    return socket;
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.dispatchEvent(new Event("close"));
  }

  open(): void {
    this.dispatchEvent(new Event("open"));
  }

  receive(message: LiveServerMessage): void {
    const event = new Event("message") as Event & { data: string };
    event.data = JSON.stringify(message);
    this.dispatchEvent(event);
  }
}
