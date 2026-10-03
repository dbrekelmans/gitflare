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
  failPrepare: false,
}));

vi.mock("@/data/account.functions", () => ({
  getMe: () => server.api.account.me({ user: server.user }),
  listMembers: () => server.api.account.listMembers({ user: server.user }),
  setMemberRole: ({ data }: { data: unknown }) =>
    server.api.account.setMemberRole({ user: server.user }, SetMemberRoleInput.parse(data)),
  getSettings: () => server.api.account.getSettings({ user: server.user }),
  updateSettings: ({ data }: { data: unknown }) =>
    server.api.account.updateSettings({ user: server.user }, UpdateSettingsInput.parse(data)),
  prepareWorkspace: () => {
    if (server.failPrepare) return Promise.reject(new Error("workspace preparation refused"));
    return server.api.account.prepareWorkspace({ user: server.user });
  },
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

afterEach(() => {
  cleanup();
  server.failPrepare = false;
});

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

  it("shows preparing in progress from `preparation`, not only from the mutation's own pending state", async () => {
    await renderSettings({
      data: demoWith((data) => {
        data.organisation.settings.workspace.snapshot = { id: "snap_demo", image: "debian" };
        data.organisation.settings.workspace.preparation = {
          state: "running",
          startedAt: Date.now(),
        };
      }),
    });
    // The mutation that started it has long since resolved; `preparation`
    // is the only thing still saying it is running.
    expect(screen.getByText("preparing")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Preparing…" })).toBeTruthy();
  });

  it("shows a failed preparation with its reason", async () => {
    await renderSettings({
      data: demoWith((data) => {
        data.organisation.settings.workspace.preparation = {
          state: "failed",
          failedAt: Date.now(),
          error: "The managed image could not be reached.",
        };
      }),
    });
    expect(screen.getByText("not prepared")).toBeTruthy();
    expect(screen.getByText("The managed image could not be reached.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Prepare workspace" })).toBeTruthy();
  });

  it("keeps polling after the mutation resolves, so a workspace the backend finishes preparing in the background still turns 'prepared' without a manual reload", async () => {
    await renderSettings();
    const base = await server.api.account.getSettings({ user: demoUsers.maya });

    // The real backend accepts the request and returns immediately,
    // writing neither a snapshot nor `preparation: running` on this
    // response (see the task comment on GF-49): the only way the page
    // ever learns the real preparation finished is by polling.
    server.api.account.prepareWorkspace = () => Promise.resolve(undefined);
    let prepared = false;
    server.api.account.getSettings = () =>
      Promise.resolve({
        ...base,
        workspace: prepared
          ? { ...base.workspace, snapshot: { id: "snap_live", image: base.workspace.image } }
          : base.workspace,
      });

    fireEvent.click(screen.getByRole("button", { name: "Prepare workspace" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Prepare workspace" })).toBeTruthy(),
    );

    // The real preparation finishes well after the request that kicked
    // it off already resolved. The poll interval is 3s; give it room.
    prepared = true;
    await waitFor(() => expect(screen.getByText("prepared")).toBeTruthy(), { timeout: 8000 });
  }, 10000);

  it("re-preparing an already-prepared workspace does not get stuck on 'Preparing…'", async () => {
    await renderSettings({
      data: demoWith((data) => {
        data.organisation.settings.workspace.snapshot = { id: "snap_demo", image: "debian" };
      }),
    });
    fireEvent.click(screen.getByRole("button", { name: "Prepare again" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Prepare again" })).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Preparing…" })).toBeNull();
    expect(screen.getByText("prepared")).toBeTruthy();
  });

  it("does not get stuck on 'Preparing…' when the request is refused", async () => {
    server.failPrepare = true;
    await renderSettings();
    fireEvent.click(screen.getByRole("button", { name: "Prepare workspace" }));
    await waitFor(() => expect(screen.getByText("workspace preparation refused")).toBeTruthy());
    expect(screen.getByRole("button", { name: "Prepare workspace" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Preparing…" })).toBeNull();
    expect(screen.getByText("not prepared")).toBeTruthy();
  });
});

describe("the workspace, for a member", () => {
  it("shows its state but offers no action", async () => {
    await renderSettings({ as: demoUsers.jonas });
    expect(screen.getByText("not prepared")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /[Pp]repare/ })).toBeNull();
  });
});
