import type { User } from "@gitflare/core";
import type { ForgeApi } from "@gitflare/core/api";
import { SetMemberRoleInput, UpdateSettingsInput } from "@gitflare/core/api";
import { type DemoData, demo, demoUsers } from "@gitflare/testing/demo";
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
import { SettingsPage } from "./settings-page";

const server = vi.hoisted(() => ({
  api: undefined as unknown as ForgeApi,
  user: undefined as unknown as User,
}));

vi.mock("@/data/account.functions", () => ({
  getMe: () => server.api.account.me({ user: server.user }),
  listMembers: () => server.api.account.listMembers({ user: server.user }),
  setMemberRole: ({ data }: { data: unknown }) =>
    server.api.account.setMemberRole({ user: server.user }, SetMemberRoleInput.parse(data)),
  getSettings: () => server.api.account.getSettings({ user: server.user }),
  updateSettings: ({ data }: { data: unknown }) =>
    server.api.account.updateSettings({ user: server.user }, UpdateSettingsInput.parse(data)),
  prepareWorkspace: () => server.api.account.prepareWorkspace({ user: server.user }),
  getBudget: () => server.api.account.budget({ user: server.user }),
}));

function demoWith(change: (data: DemoData) => void): DemoData {
  const data = structuredClone(demo);
  change(data);
  return data;
}

async function renderSettings({
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
    routeTree: createRootRoute({ component: SettingsPage }),
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

describe("members, for an administrator", () => {
  it("lists every member with their role, and can change one", async () => {
    await renderSettings();
    const jonasRow = within(screen.getByTestId(`member-${demoUsers.jonas.id}`));
    expect(jonasRow.getByText("member")).toBeTruthy();

    fireEvent.click(jonasRow.getByRole("button", { name: "Make admin" }));
    await waitFor(() => expect(jonasRow.getByText("admin")).toBeTruthy());
  });

  it("cannot change its own role", async () => {
    await renderSettings();
    const mayaRow = within(screen.getByTestId(`member-${demoUsers.maya.id}`));
    expect(mayaRow.queryByRole("button", { name: /^Make /i })).toBeNull();
  });
});

describe("members, for a member", () => {
  it("cannot change anyone's role", async () => {
    await renderSettings({ as: demoUsers.jonas });
    expect(screen.queryByRole("button", { name: /^Make / })).toBeNull();
    expect(screen.getByText("Only an administrator can change a member's role.")).toBeTruthy();
  });
});

describe("spend", () => {
  it("shows what has been spent this month, against the budget", async () => {
    await renderSettings();
    const { summary, perChangeBudgetMicroUsd } = await server.api.account.budget({
      user: demoUsers.maya,
    });
    expect(
      screen.getByText(new RegExp(`of \\$${(summary.budgetMicroUsd / 1_000_000).toFixed(2)}`)),
    ).toBeTruthy();
    expect(
      screen.getByText(new RegExp(`\\$${(perChangeBudgetMicroUsd / 1_000_000).toFixed(2)} cap`)),
    ).toBeTruthy();
  });
});

describe("the workspace, for an administrator", () => {
  it("shows as not prepared, and can be prepared", async () => {
    await renderSettings();
    expect(screen.getByText("not prepared")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Prepare workspace" }));
    await waitFor(() => expect(screen.getByText("prepared")).toBeTruthy());
    expect(screen.getByText(/snapshot snap_fixture/)).toBeTruthy();
  });

  it("shows as prepared when a snapshot already exists", async () => {
    await renderSettings({
      data: demoWith((data) => {
        data.organisation.settings.workspace.snapshot = { id: "snap_demo", image: "debian" };
      }),
    });
    expect(screen.getByText("prepared")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Prepare again" })).toBeTruthy();
  });
});

describe("the workspace, for a member", () => {
  it("shows its state but offers no action", async () => {
    await renderSettings({ as: demoUsers.jonas });
    expect(screen.getByText("not prepared")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /[Pp]repare/ })).toBeNull();
  });
});
