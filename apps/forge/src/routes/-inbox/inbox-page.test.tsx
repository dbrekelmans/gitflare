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
import { cleanup, render, screen, within } from "@testing-library/react";
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

const needsYou = () => within(screen.getByRole("region", { name: "Needs you" }));
const inFlight = () => within(screen.getByRole("region", { name: "In flight" }));

afterEach(cleanup);

describe("the inbox, against the demo", () => {
  it("puts a ready change still waiting on the viewer's approval into needs you, not in flight", async () => {
    await renderInbox({ as: demoUsers.maya });
    expect(needsYou().getByRole("link", { name: demoChanges.review.title })).toBeTruthy();
    expect(inFlight().queryByRole("link", { name: demoChanges.review.title })).toBeNull();
  });

  it("puts the change's own author's view of it under in flight, not needs you", async () => {
    await renderInbox({ as: demoUsers.jonas });
    expect(needsYou().queryByRole("link", { name: demoChanges.review.title })).toBeNull();
    expect(inFlight().getByRole("link", { name: demoChanges.review.title })).toBeTruthy();
  });

  it("leaves a merged change out of both sections", async () => {
    await renderInbox();
    expect(needsYou().queryByRole("link", { name: demoChanges.merged.title })).toBeNull();
    expect(inFlight().queryByRole("link", { name: demoChanges.merged.title })).toBeNull();
  });

  it("puts a change still being processed under in flight, never needs you", async () => {
    await renderInbox({ as: demoUsers.priya });
    expect(inFlight().getByRole("link", { name: demoChanges.cloud.title })).toBeTruthy();
    expect(needsYou().queryByRole("link", { name: demoChanges.cloud.title })).toBeNull();
  });

  it("says nothing is waiting when every change has merged or closed", async () => {
    await renderInbox({
      data: demoWith((data) => {
        for (const change of data.changes) change.status = "merged";
      }),
    });
    expect(needsYou().getByText("Nothing is waiting on you.")).toBeTruthy();
    expect(inFlight().getByText("Nothing else in flight.")).toBeTruthy();
  });
});
