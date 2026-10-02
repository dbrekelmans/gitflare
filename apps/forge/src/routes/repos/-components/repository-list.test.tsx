import type { User } from "@gitflare/core";
import { type DemoData, demo, demoUsers } from "@gitflare/testing/demo";
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
import { RepositoryList } from "./repository-list";

const server = vi.hoisted(() => ({
  api: undefined as unknown as ReturnType<typeof createFixtureApi>,
  user: undefined as unknown as User,
}));

vi.mock("@/data/repositories.functions", () => ({
  listRepositories: () => server.api.repositories.list({ user: server.user }),
}));

function demoWith(change: (data: DemoData) => void): DemoData {
  const data = structuredClone(demo);
  change(data);
  return data;
}

async function renderList({
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
    routeTree: createRootRoute({ component: RepositoryList }),
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

describe("the repository list, against the demo", () => {
  it("shows each ready repository with its open changes and decisions", async () => {
    await renderList();
    expect(screen.getByRole("link", { name: "atlas-web" })).toBeTruthy();
    expect(screen.getByText("2 open · 4 decisions")).toBeTruthy();
  });

  it("shows a repository whose import has not finished as importing, with no counts", async () => {
    await renderList({
      data: demoWith((data) => {
        const billing = data.repositories.find((r) => r.slug === "billing-worker");
        if (billing) billing.readyAt = null;
      }),
    });
    expect(screen.getByRole("link", { name: "billing-worker" })).toBeTruthy();
    expect(screen.getAllByText("importing").length).toBeGreaterThan(0);
    // The other repository is ready and still shows its counts.
    expect(screen.getByText(/open/)).toBeTruthy();
  });
});
