import type { User } from "@gitflare/core";
import { CreateRepositoryInput } from "@gitflare/core/api";
import { demoUsers } from "@gitflare/testing/demo";
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
import { NewRepository } from "./new";

const server = vi.hoisted(() => ({
  api: undefined as unknown as ReturnType<typeof createFixtureApi>,
  user: undefined as unknown as User,
  creates: [] as unknown[],
}));

vi.mock("@/data/repositories.functions", () => ({
  createRepository: ({ data }: { data: unknown }) => {
    server.creates.push(data);
    return server.api.repositories.create({ user: server.user }, CreateRepositoryInput.parse(data));
  },
}));

async function renderNewRepository({ as = demoUsers.maya }: { as?: User } = {}) {
  server.api = createFixtureApi();
  server.user = as;
  server.creates = [];
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rootRoute = createRootRoute();
  const newRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/repos/new",
    component: NewRepository,
  });
  const repoRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/repos/$repoSlug",
    component: function Landed() {
      const { repoSlug } = repoRoute.useParams();
      return <div data-testid="landed-on-repo">{repoSlug}</div>;
    },
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([newRoute, repoRoute]),
    history: createMemoryHistory({ initialEntries: ["/repos/new"] }),
  });
  render(
    <QueryClientProvider client={queryClient}>
      {/* biome-ignore lint/suspicious/noExplicitAny: a two-route router is not the app's registered one */}
      <RouterProvider router={router as any} />
    </QueryClientProvider>,
  );
  await screen.findByRole("heading", { level: 1 });
}

function fillForm({ slug, importUrl }: { slug: string; importUrl?: string }) {
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: slug } });
  if (importUrl) {
    fireEvent.change(screen.getByLabelText("Import from"), { target: { value: importUrl } });
  }
}

afterEach(cleanup);

describe("creating a repository", () => {
  it("creates an empty one and lands on its page", async () => {
    await renderNewRepository();
    fillForm({ slug: "new-service" });
    fireEvent.click(screen.getByRole("button", { name: "Create repository" }));

    await waitFor(() => expect(screen.getByTestId("landed-on-repo")).toBeTruthy());
    expect(screen.getByTestId("landed-on-repo").textContent).toBe("new-service");
    expect(server.creates).toEqual([
      { slug: "new-service", description: "", importUrl: undefined },
    ]);
  });

  it("passes the import URL through when importing one", async () => {
    await renderNewRepository();
    fillForm({ slug: "imported-service", importUrl: "https://github.com/acme/thing.git" });
    fireEvent.click(screen.getByRole("button", { name: "Create repository" }));

    await waitFor(() => expect(screen.getByTestId("landed-on-repo")).toBeTruthy());
    expect(server.creates).toEqual([
      {
        slug: "imported-service",
        description: "",
        importUrl: "https://github.com/acme/thing.git",
      },
    ]);
  });

  it("rejects an invalid name before calling the server, without navigating", async () => {
    await renderNewRepository();
    fillForm({ slug: "Not Valid!" });
    fireEvent.click(screen.getByRole("button", { name: "Create repository" }));

    expect(await screen.findByText(/lowercase letters, digits and hyphens/)).toBeTruthy();
    expect(server.creates).toEqual([]);
    expect(screen.queryByTestId("landed-on-repo")).toBeNull();
  });

  it("shows the server's refusal when the caller may not create one", async () => {
    await renderNewRepository({ as: demoUsers.jonas });
    fillForm({ slug: "members-cant" });
    fireEvent.click(screen.getByRole("button", { name: "Create repository" }));

    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.queryByTestId("landed-on-repo")).toBeNull();
  });
});
