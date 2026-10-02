import type { User } from "@gitflare/core";
import { type ForgeApi, StartSessionInput } from "@gitflare/core/api";
import { demo, demoUsers } from "@gitflare/testing/demo";
import { createFixtureApi } from "@gitflare/testing/fixture-api";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NewSessionForm } from "./new-session-form";

const server = vi.hoisted(() => ({
  api: undefined as unknown as ForgeApi,
  user: undefined as unknown as User,
}));

// The form navigates on success; a one-route test router has nowhere to go,
// so `useNavigate` is swapped for a spy and the rest of the module is real.
const navigate = vi.hoisted(() => vi.fn());
vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return { ...actual, useNavigate: () => navigate };
});

vi.mock("@/data/repositories.functions", () => ({
  listRepositories: () =>
    server.api.repositories.list({ user: server.user }).then((v) => structuredClone(v)),
}));

vi.mock("@/data/sessions.functions", () => ({
  startSession: ({ data }: { data: unknown }) =>
    server.api.sessions
      .start({ user: server.user }, StartSessionInput.parse(data))
      .then((v) => structuredClone(v)),
}));

async function renderForm({ as = demoUsers.maya }: { as?: User } = {}) {
  server.api = createFixtureApi(demo);
  server.user = as;
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createRouter({
    routeTree: createRootRoute({ component: NewSessionForm }),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  render(
    <QueryClientProvider client={queryClient}>
      {/* biome-ignore lint/suspicious/noExplicitAny: a one-route router is not the app's registered one */}
      <RouterProvider router={router as any} />
    </QueryClientProvider>,
  );
  await screen.findByRole("button", { name: "Start session" });
}

afterEach(() => {
  cleanup();
  navigate.mockClear();
});

describe("starting a session", () => {
  it("defaults to the first repository, running locally, with no prompt field", async () => {
    await renderForm();
    expect(screen.getByRole("combobox", { name: "Repository" }).textContent).toBe("atlas-web");
    expect(screen.getByRole("radio", { name: /Local/, checked: true })).toBeTruthy();
    expect(screen.queryByLabelText("First instruction")).toBeNull();
  });

  it("shows the prompt field only once Hosted is chosen", async () => {
    await renderForm();
    fireEvent.click(screen.getByRole("radio", { name: /Hosted/ }));
    expect(screen.getByLabelText("First instruction")).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: /Local/ }));
    expect(screen.queryByLabelText("First instruction")).toBeNull();
  });

  it("refuses to submit an empty title, in plain words", async () => {
    await renderForm();
    fireEvent.click(screen.getByRole("button", { name: "Start session" }));
    expect(await screen.findByText("Required.")).toBeTruthy();
  });

  it("starts a local session and navigates to its page", async () => {
    await renderForm();
    fireEvent.change(screen.getByLabelText("Title"), {
      target: { value: "A session from a test" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Start session" }));
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith(
        expect.objectContaining({
          to: "/sessions/$sessionId",
          params: { sessionId: expect.any(String) },
        }),
      ),
    );
  });

  it("starts a hosted session with its first prompt", async () => {
    await renderForm();
    fireEvent.click(screen.getByRole("radio", { name: /Hosted/ }));
    fireEvent.change(screen.getByLabelText("Title"), {
      target: { value: "A hosted session from a test" },
    });
    fireEvent.change(screen.getByLabelText("First instruction"), {
      target: { value: "Do the thing" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Start session" }));
    await waitFor(() => expect(navigate).toHaveBeenCalled());
  });
});
