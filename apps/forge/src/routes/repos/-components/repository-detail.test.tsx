import type { User } from "@gitflare/core";
import { RepoRef } from "@gitflare/core/api";
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
import { RepositoryPage } from "./repository-detail";

const server = vi.hoisted(() => ({
  api: undefined as unknown as ReturnType<typeof createFixtureApi>,
  user: undefined as unknown as User,
}));

vi.mock("@/data/repositories.functions", () => ({
  getRepository: ({ data }: { data: unknown }) =>
    server.api.repositories.get({ user: server.user }, RepoRef.parse(data)),
}));

function demoWith(change: (data: DemoData) => void): DemoData {
  const data = structuredClone(demo);
  change(data);
  return data;
}

async function renderRepository({
  repoSlug,
  as = demoUsers.maya,
  data = demo,
}: {
  repoSlug: string;
  as?: User;
  data?: DemoData;
}) {
  server.api = createFixtureApi(data);
  server.user = as;
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createRouter({
    routeTree: createRootRoute({ component: () => <RepositoryPage repoSlug={repoSlug} /> }),
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

describe("a repository page, against the demo", () => {
  it("shows how to clone it and that capture is on", async () => {
    await renderRepository({ repoSlug: "atlas-web" });
    expect(screen.getByText(/git clone/)).toBeTruthy();
    expect(screen.getByText("on")).toBeTruthy();
    expect(screen.queryByText("gitflare capture enable")).toBeNull();
  });

  it("says how to turn capture on when it is off", async () => {
    await renderRepository({ repoSlug: "billing-worker" });
    expect(screen.getByText("off")).toBeTruthy();
    expect(screen.getByText("gitflare capture enable")).toBeTruthy();
  });

  it("shows a freshly started import as not ready, with no clone instructions", async () => {
    await renderRepository({
      repoSlug: "billing-worker",
      data: demoWith((data) => {
        const billing = data.repositories.find((r) => r.slug === "billing-worker");
        if (billing) {
          billing.readyAt = null;
          billing.createdAt = Date.now();
        }
      }),
    });
    expect(screen.getByText("importing")).toBeTruthy();
    expect(screen.getByText(/still being imported/)).toBeTruthy();
    expect(screen.queryByText(/git clone/)).toBeNull();
    expect(screen.queryByText("not responding")).toBeNull();
  });

  it("says an import running a long time may have failed", async () => {
    await renderRepository({
      repoSlug: "billing-worker",
      data: demoWith((data) => {
        const billing = data.repositories.find((r) => r.slug === "billing-worker");
        if (billing) {
          billing.readyAt = null;
          billing.createdAt = Date.now() - 60 * 60 * 1000;
        }
      }),
    });
    expect(screen.getByText("not responding")).toBeTruthy();
    expect(screen.getByText(/may have failed/)).toBeTruthy();
    expect(screen.queryByText(/still being imported/)).toBeNull();
    expect(screen.queryByText(/git clone/)).toBeNull();
  });

  it("says the remote is not available yet when the repository is ready but the host has none", async () => {
    // Against the real backend a repository can be marked ready before its
    // git host remote is reported (see `repositoriesApi.get`'s comment on an
    // empty remote); the fixture never produces this, so it is built by hand.
    const billing = demo.repositories.find((r) => r.slug === "billing-worker");
    if (!billing) throw new Error("the demo always has billing-worker");
    server.api = {
      repositories: {
        get: async () => ({
          repository: billing,
          openChanges: 0,
          activeDecisions: 0,
          remote: "",
          contextRemote: "",
          recentCommits: [],
        }),
      },
      // biome-ignore lint/suspicious/noExplicitAny: only `repositories.get` is exercised by this page
    } as any;
    server.user = demoUsers.maya;
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const router = createRouter({
      routeTree: createRootRoute({
        component: () => <RepositoryPage repoSlug="billing-worker" />,
      }),
      history: createMemoryHistory({ initialEntries: ["/"] }),
    });
    render(
      <QueryClientProvider client={queryClient}>
        {/* biome-ignore lint/suspicious/noExplicitAny: a one-route router is not the app's registered one */}
        <RouterProvider router={router as any} />
      </QueryClientProvider>,
    );
    await screen.findByRole("heading", { level: 1 });

    expect(screen.getAllByText("Not available yet.").length).toBe(2);
    expect(screen.queryByText(/git clone/)).toBeNull();
  });
});
