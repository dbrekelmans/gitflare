import type { User } from "@gitflare/core";
import { CreateDecisionInput, type ForgeApi, ListDecisionsInput } from "@gitflare/core/api";
import { DEMO_SLUG, demo, demoUsers } from "@gitflare/testing/demo";
import { createFixtureApi } from "@gitflare/testing/fixture-api";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Decisions } from "./decisions-list";

const server = vi.hoisted(() => ({
  api: undefined as unknown as ForgeApi,
  user: undefined as unknown as User,
}));

vi.mock("@/data/decisions.functions", () => ({
  listDecisions: ({ data }: { data: unknown }) =>
    server.api.decisions.list({ user: server.user }, ListDecisionsInput.parse(data)),
  createDecision: ({ data }: { data: unknown }) =>
    server.api.decisions.create({ user: server.user }, CreateDecisionInput.parse(data)),
}));

async function renderList({ as = demoUsers.maya }: { as?: User } = {}) {
  server.api = createFixtureApi(demo);
  server.user = as;
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const root = createRootRoute();
  // A stub for where "Add decision" takes the author: just enough to prove the navigation landed.
  const indexRoute = createRoute({
    getParentRoute: () => root,
    path: "/",
    component: () => <Decisions repoSlug={DEMO_SLUG} />,
  });
  const decisionRoute = createRoute({
    getParentRoute: () => root,
    path: "/decisions/$decisionId",
    component: () => <h1>{decisionRoute.useParams().decisionId}</h1>,
  });
  const router = createRouter({
    routeTree: root.addChildren([indexRoute, decisionRoute]),
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

describe("the decision record, against the demo", () => {
  it("lists active decisions separately from dormant ones", async () => {
    await renderList();
    expect(
      screen.getByRole("link", { name: "Never log access tokens or invite codes" }),
    ).toBeTruthy();
    expect(screen.getByRole("link", { name: "Use moment for date handling" })).toBeTruthy();

    const dormantSection = screen.getByRole("region", { name: "Dormant" });
    expect(Array.from(dormantSection.querySelectorAll("a")).map((a) => a.textContent)).toContain(
      "Use moment for date handling",
    );
    const activeSection = screen.getByRole("region", { name: "Active" });
    expect(Array.from(activeSection.querySelectorAll("a")).map((a) => a.textContent)).not.toContain(
      "Use moment for date handling",
    );
  });

  it("adds a decision and takes the author to its page", async () => {
    await renderList();
    fireEvent.click(screen.getByRole("button", { name: "Add decision" }));

    fireEvent.change(screen.getByLabelText("Title"), {
      target: { value: "Prefer composition over inheritance" },
    });
    fireEvent.change(screen.getByLabelText("Statement"), {
      target: { value: "New domain types compose smaller pieces rather than extending a base." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add decision" }));

    await waitFor(() => expect(screen.getByRole("heading").textContent).toMatch(/^dec_/));
  });
});
