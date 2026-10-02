import type { Session, SessionId, User } from "@gitflare/core";
import {
  type ForgeApi,
  PromptSessionInput,
  SessionEventsInput,
  SessionRef,
} from "@gitflare/core/api";
import { type DemoData, demo, demoChanges, demoUsers } from "@gitflare/testing/demo";
import { createFixtureApi } from "@gitflare/testing/fixture-api";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionPage } from "./session-page";

// Rendered for real over the fixture API, as in `change-page.test.tsx`.
const server = vi.hoisted(() => ({
  api: undefined as unknown as ForgeApi,
  user: undefined as unknown as User,
}));

vi.mock("@/data/sessions.functions", () => ({
  getSession: ({ data }: { data: unknown }) =>
    server.api.sessions.get({ user: server.user }, SessionRef.parse(data)),
  getSessionEvents: ({ data }: { data: unknown }) =>
    server.api.sessions.events({ user: server.user }, SessionEventsInput.parse(data)),
  promptSession: ({ data }: { data: unknown }) =>
    server.api.sessions.prompt({ user: server.user }, PromptSessionInput.parse(data)),
  stopSession: ({ data }: { data: unknown }) =>
    server.api.sessions.stop({ user: server.user }, SessionRef.parse(data)),
  abandonSession: ({ data }: { data: unknown }) =>
    server.api.sessions.abandon({ user: server.user }, SessionRef.parse(data)),
}));

vi.mock("@/data/account.functions", () => ({
  getMe: () => server.api.account.me({ user: server.user }),
}));

/** The demo with something about it changed, so a state the demo does not hold can be shown. */
function demoWith(change: (data: DemoData) => void): DemoData {
  const data = structuredClone(demo);
  change(data);
  return data;
}

function sessionIn(data: DemoData, sessionId: SessionId): Session {
  return (
    data.sessions.find((s) => s.id === sessionId) ??
    (() => {
      throw new Error("session not found");
    })()
  );
}

async function renderSession({
  as = demoUsers.maya,
  data = demo,
  sessionId = demoChanges.cloud.sessionId,
}: {
  as?: User;
  data?: DemoData;
  sessionId?: SessionId;
} = {}) {
  server.api = createFixtureApi(data);
  server.user = as;
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createRouter({
    routeTree: createRootRoute({ component: () => <SessionPage sessionId={sessionId} /> }),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  render(
    <QueryClientProvider client={queryClient}>
      {/* biome-ignore lint/suspicious/noExplicitAny: a one-route router is not the app's registered one */}
      <RouterProvider router={router as any} />
    </QueryClientProvider>,
  );
  await screen.findByRole("heading", { level: 1 });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("a session still forking", () => {
  it("shows as preparing until forkReadyAt is set, and offers nothing else", async () => {
    await renderSession({
      data: demoWith((data) => {
        sessionIn(data, demoChanges.review.sessionId).forkReadyAt = null;
      }),
      sessionId: demoChanges.review.sessionId,
    });
    expect(screen.getAllByText("Preparing").length).toBeGreaterThan(0);
    expect(screen.queryByText(/Push to/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Abandon" })).toBeNull();
  });
});

describe("a hosted session's page, for its owner", () => {
  it("shows the push remote, the prompt box and the agent's events", async () => {
    await renderSession();
    expect(screen.getByText(/https:\/\/git\.example\.test/)).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "Prompt" })).toBeTruthy();
    const events = within(screen.getByRole("list", { name: "What the agent did" }));
    expect(events.getAllByRole("listitem").length).toBeGreaterThan(0);
  });

  it("sends a prompt and it appears in the event log", async () => {
    await renderSession();
    const box = screen.getByRole("textbox", { name: "Prompt" });
    fireEvent.change(box, { target: { value: "Add a test for the export" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(screen.getByText("Add a test for the export")).toBeTruthy());
    expect((box as HTMLTextAreaElement).value).toBe("");
  });

  it("offers stop and abandon to the owner", async () => {
    await renderSession();
    expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Abandon" })).toBeTruthy();
  });

  it("stops the session", async () => {
    await renderSession();
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    await waitFor(() => expect(screen.getByText("Asleep")).toBeTruthy());
  });

  it("abandons the session", async () => {
    window.confirm = () => true;
    await renderSession();
    fireEvent.click(screen.getByRole("button", { name: "Abandon" }));
    await waitFor(() => expect(screen.getByText("abandoned")).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Abandon" })).toBeNull();
  });
});

describe("a hosted session's page, for someone who is not its owner", () => {
  it("does not offer to prompt, stop or abandon it", async () => {
    await renderSession({ as: demoUsers.jonas });
    expect(screen.queryByRole("textbox", { name: "Prompt" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Abandon" })).toBeNull();
  });
});

describe("a local session's page", () => {
  it("shows the fork and the change it opened, with no agent events", async () => {
    await renderSession({ as: demoUsers.jonas, sessionId: demoChanges.review.sessionId });
    expect(screen.getByText(/https:\/\/git\.example\.test/)).toBeTruthy();
    expect(screen.getByRole("link", { name: /Rate-limit the invite endpoint/ })).toBeTruthy();
    expect(screen.queryByText("What the agent did")).toBeNull();
    expect(screen.queryByRole("textbox", { name: "Prompt" })).toBeNull();
  });
});
