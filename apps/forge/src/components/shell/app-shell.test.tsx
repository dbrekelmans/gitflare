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

// happy-dom does not run a real layout engine, so none of these tests can
// measure actual page width or catch horizontal overflow the way a browser
// at a real viewport size can (that was verified by hand in `pnpm dev` —
// see the task comment on GF-49). These only check the className-level
// contract: that wrapping is disabled where it must be, and that the one
// group allowed to lose content below 1024px (the spend line) actually
// does, rather than forcing the header wider than the viewport.
describe("the app shell's header, which must not wrap or overflow at 768px", () => {
  it("never wraps a destination's label mid-word", async () => {
    await renderShell();
    for (const label of ["Inbox", "Repositories", "Sessions", "Settings"]) {
      const link = screen.getByRole("link", { name: label });
      expect(link.className).toContain("whitespace-nowrap");
    }
  });

  it("keeps the wordmark and the nav from shrinking, so neither stacks its own text", async () => {
    await renderShell();
    const wordmark = screen.getByRole("link", { name: "gitflare, inbox" });
    expect(wordmark.className).toContain("shrink-0");
    const nav = screen.getByRole("navigation", { name: "Main" });
    expect(nav.className).toContain("shrink-0");
  });

  it("hides the spend line below 1024px instead of forcing the header wider than the viewport", async () => {
    await renderShell();
    const spend = screen.getByText(/this month/);
    expect(spend.className).toContain("hidden");
    expect(spend.className).toContain("lg:inline-flex");
  });

  it("truncates the account name rather than letting it push the header wider", async () => {
    await renderShell();
    const name = screen.getByText("Maya Okafor");
    expect(name.className).toContain("truncate");
    const rightGroup = name.closest("div");
    if (!rightGroup) throw new Error("the account group has no wrapping div");
    expect(rightGroup.className).toContain("min-w-0");
  });
});
