import type { ChangeId } from "@gitflare/core";
import type { LiveServerMessage } from "@gitflare/core/api";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { keys } from "./keys";
import { useChangeLive } from "./live";

/** Stands in for a browser `WebSocket`: records what was sent, and lets a test play the server's part. */
class FakeWebSocket extends EventTarget {
  static instances: FakeWebSocket[] = [];
  readonly url: string;
  readonly sent: string[] = [];
  closed = false;

  constructor(url: string) {
    super();
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
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

beforeEach(() => {
  FakeWebSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeWebSocket);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function wrapper(queryClient: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

describe("useChangeLive", () => {
  it("invalidates the change's query when an event arrives", () => {
    const changeId = "chg_live_a" as ChangeId;
    const queryClient = new QueryClient();
    queryClient.setQueryData(keys.changes.one(changeId), { ok: true });

    renderHook(() => useChangeLive(changeId), { wrapper: wrapper(queryClient) });
    const socket = FakeWebSocket.instances[0];
    expect(socket).toBeDefined();

    act(() => socket?.open());
    act(() => socket?.receive({ type: "hello", changeId, lastSeq: 0 }));
    expect(queryClient.getQueryState(keys.changes.one(changeId))?.isInvalidated).toBe(false);

    act(() =>
      socket?.receive({
        type: "event",
        event: { type: "intent.updated", changeId, seq: 1, at: 0 },
      }),
    );
    expect(queryClient.getQueryState(keys.changes.one(changeId))?.isInvalidated).toBe(true);
  });

  it("shares one socket between two components watching the same change", () => {
    const changeId = "chg_live_b" as ChangeId;
    const queryClient = new QueryClient();

    const { unmount: unmountA } = renderHook(() => useChangeLive(changeId), {
      wrapper: wrapper(queryClient),
    });
    const { unmount: unmountB } = renderHook(() => useChangeLive(changeId), {
      wrapper: wrapper(queryClient),
    });

    expect(FakeWebSocket.instances.length).toBe(1);

    unmountA();
    expect(FakeWebSocket.instances[0]?.closed).toBe(false);

    unmountB();
    expect(FakeWebSocket.instances[0]?.closed).toBe(true);
  });
});
