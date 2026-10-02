import type { User } from "@gitflare/core";
import { ListChangesInput } from "@gitflare/core/api";
import { type DemoData, demo, demoChanges, demoUsers } from "@gitflare/testing/demo";
import { createFixtureApi } from "@gitflare/testing/fixture-api";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InboxPage } from "./inbox-page";

const server = vi.hoisted(() => ({
  api: undefined as unknown as ReturnType<typeof createFixtureApi>,
  user: undefined as unknown as User,
}));

vi.mock("@/data/changes.functions", () => ({
  listChanges: ({ data }: { data: unknown }) =>
    server.api.changes.list({ user: server.user }, ListChangesInput.parse(data)),
}));

function demoWith(change: (data: DemoData) => void): DemoData {
  const data = structuredClone(demo);
  change(data);
  return data;
}

async function renderInbox({
  as = demoUsers.maya,
  data = demo,
}: {
  as?: User;
  data?: DemoData;
} = {}) {
  server.api = createFixtureApi(data);
  server.user = as;
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createRouter({
    routeTree: createRootRoute({ component: InboxPage }),
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

afterEach(cleanup);

describe("the inbox, against the demo", () => {
  it("puts a ready change still waiting on the viewer's approval into needs you", async () => {
    await renderInbox({ as: demoUsers.maya });
    expect(screen.getByText("Needs you")).toBeTruthy();
    expect(screen.getByRole("link", { name: demoChanges.review.title })).toBeTruthy();
  });

  it("does not put the change's own author into needs you for it, even though it is ready", async () => {
    await renderInbox({ as: demoUsers.jonas });
    expect(screen.getByText("Nothing is waiting on you.")).toBeTruthy();
    // It still shows, just as everything else in flight rather than needing them.
    expect(screen.getByRole("link", { name: demoChanges.review.title })).toBeTruthy();
  });

  it("leaves a merged change out of both sections", async () => {
    await renderInbox();
    expect(screen.queryByRole("link", { name: demoChanges.merged.title })).toBeNull();
  });

  it("puts a change still being processed under in flight, never needs you", async () => {
    await renderInbox({ as: demoUsers.priya });
    expect(screen.getByRole("link", { name: demoChanges.cloud.title })).toBeTruthy();
  });

  it("says nothing is waiting when every change has merged or closed", async () => {
    await renderInbox({
      data: demoWith((data) => {
        for (const change of data.changes) change.status = "merged";
      }),
    });
    expect(screen.getByText("Nothing is waiting on you.")).toBeTruthy();
    expect(screen.getByText("Nothing else in flight.")).toBeTruthy();
  });
});
