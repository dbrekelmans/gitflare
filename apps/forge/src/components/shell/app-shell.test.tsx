import type { User } from "@gitflare/core";
import { demo, demoUsers } from "@gitflare/testing/demo";
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
import { AppShell } from "./app-shell";

const server = vi.hoisted(() => ({
  api: undefined as unknown as ReturnType<typeof createFixtureApi>,
  user: undefined as unknown as User,
}));

vi.mock("@/data/account.functions", () => ({
  getMe: () => server.api.account.me({ user: server.user }),
}));

async function renderShell() {
  server.api = createFixtureApi(demo);
  server.user = demoUsers.maya;
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createRouter({
    routeTree: createRootRoute({ component: () => <AppShell>content</AppShell> }),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  render(
    <QueryClientProvider client={queryClient}>
      {/* biome-ignore lint/suspicious/noExplicitAny: a one-route router is not the app's registered one */}
      <RouterProvider router={router as any} />
    </QueryClientProvider>,
  );
  await screen.findByRole("navigation", { name: "Main" });
}

afterEach(cleanup);

describe("the app shell's main navigation", () => {
  it("never wraps a destination's label mid-word, however narrow the viewport", async () => {
    await renderShell();
    for (const label of ["Inbox", "Repositories", "Sessions", "Settings"]) {
      const link = screen.getByRole("link", { name: label });
      expect(link.className).toContain("whitespace-nowrap");
    }
  });
});
