import type { DecisionId, User } from "@gitflare/core";
import {
  DecisionRef,
  EditDecisionInput,
  type ForgeApi,
  RevertDecisionInput,
} from "@gitflare/core/api";
import { demo, demoUsers } from "@gitflare/testing/demo";
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
import { DecisionPage } from "./decision-page";

const server = vi.hoisted(() => ({
  api: undefined as unknown as ForgeApi,
  user: undefined as unknown as User,
}));

vi.mock("@/data/decisions.functions", () => ({
  getDecision: ({ data }: { data: unknown }) =>
    server.api.decisions.get({ user: server.user }, DecisionRef.parse(data)),
  editDecision: ({ data }: { data: unknown }) =>
    server.api.decisions.edit({ user: server.user }, EditDecisionInput.parse(data)),
  revertDecision: ({ data }: { data: unknown }) =>
    server.api.decisions.revert({ user: server.user }, RevertDecisionInput.parse(data)),
  reviveDecision: ({ data }: { data: unknown }) =>
    server.api.decisions.revive({ user: server.user }, DecisionRef.parse(data)),
}));

async function renderDecision(decisionId: DecisionId, as: User = demoUsers.maya) {
  server.api = createFixtureApi(demo);
  server.user = as;
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createRouter({
    routeTree: createRootRoute({ component: () => <DecisionPage decisionId={decisionId} /> }),
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

/** The decision's current statement, as the page header shows it — never an entry in the history. */
function header() {
  const heading = screen.getByRole("heading", { level: 1 });
  const parent = heading.parentElement;
  if (!parent) throw new Error("the heading has no parent");
  return within(parent);
}

afterEach(cleanup);

describe("a decision's page, against the demo", () => {
  it("edits the wording and records it as a reshaped event", async () => {
    await renderDecision("dec_thin_routes" as DecisionId);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));

    const statement = screen.getByLabelText("Statement");
    fireEvent.change(statement, {
      target: { value: "A route parses the request, shapes the response, and nothing else." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(
        header().getByText("A route parses the request, shapes the response, and nothing else."),
      ).toBeTruthy(),
    );
    expect(screen.getByText("Reworded")).toBeTruthy();
  });

  it("reverts a reshaped event to restore the earlier wording", async () => {
    await renderDecision("dec_no_secrets_in_logs" as DecisionId);
    expect(
      header().getByText("Log the id of a token or invite, never its value, at any log level."),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Revert to the earlier wording" }));

    await waitFor(() => expect(header().getByText("Never log access tokens.")).toBeTruthy());
  });

  it("offers reviving a dormant decision, and not an active one", async () => {
    await renderDecision("dec_moment_for_dates" as DecisionId);
    expect(screen.getByText("dormant")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Revive" }));
    await waitFor(() => expect(screen.getByText("active")).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Revive" })).toBeNull();
  });

  it("does not offer reviving an active decision", async () => {
    await renderDecision("dec_thin_routes" as DecisionId);
    expect(screen.queryByRole("button", { name: "Revive" })).toBeNull();
  });
});
