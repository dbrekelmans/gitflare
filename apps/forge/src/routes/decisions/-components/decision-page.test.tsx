import type { DecisionId, User } from "@gitflare/core";
import {
  CreateDecisionInput,
  DecisionRef,
  EditDecisionInput,
  type ForgeApi,
  RevertDecisionInput,
} from "@gitflare/core/api";
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

async function renderDecision(
  decisionId: DecisionId,
  as: User = demoUsers.maya,
  api: ForgeApi = createFixtureApi(demo),
) {
  server.api = api;
  server.user = as;
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const root = createRootRoute();
  const indexRoute = createRoute({
    getParentRoute: () => root,
    path: "/",
    component: () => <DecisionPage decisionId={decisionId} />,
  });
  // A stub for the provenance links to land on: just enough to prove they resolve.
  const changeRoute = createRoute({
    getParentRoute: () => root,
    path: "/changes/$changeId",
    component: () => <h1>the change</h1>,
  });
  // A stub for the back link to land on: just enough to prove it resolves to
  // the decision's own repository, not a fixed or history-based route.
  const decisionsRoute = createRoute({
    getParentRoute: () => root,
    path: "/repos/$repoSlug/decisions",
    component: () => {
      const { repoSlug } = decisionsRoute.useParams();
      return <h1>Decisions for {repoSlug}</h1>;
    },
  });
  const router = createRouter({
    routeTree: root.addChildren([indexRoute, changeRoute, decisionsRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  render(
    <QueryClientProvider client={queryClient}>
      {/* biome-ignore lint/suspicious/noExplicitAny: a two-route router is not the app's registered one */}
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

function historyList() {
  return within(screen.getByRole("list", { name: "Decision history" }));
}

function historyRows() {
  return historyList().getAllByRole("listitem");
}

function nthRow(n: number) {
  const row = historyRows()[n];
  if (!row) throw new Error(`no history row at index ${n}`);
  return row;
}

afterEach(cleanup);

describe("a decision's page, against the demo", () => {
  it("edits the wording and records it as a reshaped event, attributed to whoever edited", async () => {
    await renderDecision("dec_thin_routes" as DecisionId, demoUsers.priya);
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
    const rowEl = nthRow(0);
    const row = within(rowEl);
    expect(row.getByText("Reworded")).toBeTruthy();
    expect(row.getByText(/by Priya Raman/)).toBeTruthy();
  });

  it("labels a title-or-rationale-only edit 'Edited', but still shows what changed", async () => {
    await renderDecision("dec_thin_routes" as DecisionId);
    const before = historyRows().length;
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));

    fireEvent.change(screen.getByLabelText("Title"), {
      target: { value: "Keep route handlers thin" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(historyRows().length).toBe(before + 1));
    const rowEl = nthRow(0);
    const row = within(rowEl);
    expect(row.getByText("Edited")).toBeTruthy();
    expect(row.queryByText("Reworded")).toBeNull();
    // The title changed, and that change is now shown.
    expect(row.getByText("Route handlers stay thin")).toBeTruthy();
    expect(row.getByText("Keep route handlers thin")).toBeTruthy();
    // The statement is unchanged, so only the title is struck through — not it too.
    expect(rowEl.querySelectorAll(".line-through").length).toBe(1);
    // A reshaped event that changed wording can still be reverted.
    expect(row.getByRole("button", { name: /Revert/ })).toBeTruthy();
  });

  it("does not render an empty struck-through line when a rationale goes from blank to some text", async () => {
    const api = createFixtureApi(demo);
    const created = await api.decisions.create(
      { user: demoUsers.maya },
      CreateDecisionInput.parse({
        repoSlug: "atlas-web",
        title: "A decision with no rationale yet",
        statement: "Something the team decided.",
        rationale: "",
      }),
    );

    await renderDecision(created.decision.id, demoUsers.maya, api);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("Rationale"), {
      target: { value: "Because it keeps things simple." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(screen.getByText("Because it keeps things simple.")).toBeTruthy());
    const rowEl = nthRow(0);
    // The rationale is shown, but nothing is struck through: there was
    // nothing before it to strike through.
    expect(rowEl.querySelectorAll(".line-through").length).toBe(0);
  });

  it("reverts a reshaped event to restore the earlier wording", async () => {
    await renderDecision("dec_no_secrets_in_logs" as DecisionId);
    expect(
      header().getByText("Log the id of a token or invite, never its value, at any log level."),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Revert to the earlier wording" }));

    await waitFor(() => expect(header().getByText("Never log access tokens.")).toBeTruthy());
  });

  it("disables only the Revert button for the event being reverted, not every one", async () => {
    const decisionId = "dec_no_secrets_in_logs" as DecisionId;
    await renderDecision(decisionId);

    // A second edit gives the decision two reshaped events, so two Revert
    // buttons exist to tell apart.
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("Statement"), {
      target: { value: "Never put a token or invite code in a log line, at any level." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(
        screen.getAllByRole("button", { name: /^Revert to the earlier wording$/ }).length,
      ).toBe(2),
    );

    // Hold the mutation open so the pending state is observable.
    let resolveRevert: (value: Awaited<ReturnType<ForgeApi["decisions"]["revert"]>>) => void =
      () => {};
    server.api.decisions.revert = () => new Promise((resolve) => (resolveRevert = resolve));

    const buttons = screen.getAllByRole("button", { name: /^Revert to the earlier wording$/ });
    const [first, second] = [buttons[0], buttons[1]];
    if (!first || !second) throw new Error("expected two Revert buttons");
    fireEvent.click(first);

    await waitFor(() => expect(first.textContent).toBe("Reverting…"));
    expect(second.textContent).toBe("Revert to the earlier wording");
    // Resolve so the pending mutation doesn't bleed into the next test. The
    // response's content is unused: the mutation only triggers a refetch.
    resolveRevert(await server.api.decisions.get({ user: server.user }, { decisionId }));
  });

  it("shows a note alongside a wording change, not instead of it", async () => {
    await renderDecision("dec_no_secrets_in_logs" as DecisionId);
    const row = within(nthRow(2));
    expect(row.getByText("Never log access tokens.")).toBeTruthy();
    expect(
      row.getByText("Log the id of a token or invite, never its value, at any log level."),
    ).toBeTruthy();
    expect(row.getByText(/Widened to invite codes/)).toBeTruthy();
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

  it("shows where the decision came from, with a link to the change and the thread it came from", async () => {
    await renderDecision("dec_fixed_windows" as DecisionId);
    const origin = within(screen.getByRole("region", { name: "Where it came from" }));
    expect(origin.getByText("Recorded from a dismissed review comment.")).toBeTruthy();
    expect(origin.getByRole("link", { name: "The change it came from" })).toBeTruthy();
    expect(origin.getByText(/thr_demo12window/)).toBeTruthy();
  });

  it("shows who an event is attributed to, and the change it came from", async () => {
    await renderDecision("dec_fixed_windows" as DecisionId);
    const row = within(nthRow(0));
    expect(row.getByText(/by Jonas Lindqvist/)).toBeTruthy();
    expect(row.getByRole("link", { name: "the change" })).toBeTruthy();
    expect(row.getByText(/thr_demo12window/)).toBeTruthy();
  });

  it("links back to the decision's own repository, not a fixed or history-based route", async () => {
    await renderDecision("dec_thin_routes" as DecisionId);
    // A real link, not a button: a screen reader must announce it as one.
    const back = screen.getByRole("link", { name: "Back to decisions" });
    fireEvent.click(back);
    expect(await screen.findByText(`Decisions for ${DEMO_SLUG}`)).toBeTruthy();
  });
});
