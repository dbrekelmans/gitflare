import type { User } from "@gitflare/core";
import { ChangeRef, type ForgeApi, RerunStageInput, SectionRef } from "@gitflare/core/api";
import { type DemoData, demo, demoChanges, demoUsers } from "@gitflare/testing/demo";
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
import { ChangePage } from "./change-page";

// The page is rendered for real, over the fixture API: what the server
// functions would call is called directly, as whoever the test signs in.
const server = vi.hoisted(() => ({
  api: undefined as unknown as ForgeApi,
  user: undefined as unknown as User,
  diffRequests: 0,
}));

vi.mock("@/data/changes.functions", () => ({
  getChange: ({ data }: { data: unknown }) =>
    server.api.changes.get({ user: server.user }, ChangeRef.parse(data)),
  getSectionDiff: ({ data }: { data: unknown }) => {
    server.diffRequests += 1;
    return server.api.changes.sectionDiff({ user: server.user }, SectionRef.parse(data));
  },
  approveSection: ({ data }: { data: unknown }) =>
    server.api.changes.approveSection({ user: server.user }, SectionRef.parse(data)),
  revokeApproval: ({ data }: { data: unknown }) =>
    server.api.changes.revokeApproval({ user: server.user }, SectionRef.parse(data)),
  rerunStage: ({ data }: { data: unknown }) =>
    server.api.changes.rerunStage({ user: server.user }, RerunStageInput.parse(data)),
  mergeChange: ({ data }: { data: unknown }) =>
    server.api.changes.merge({ user: server.user }, ChangeRef.parse(data)),
}));

vi.mock("@/data/account.functions", () => ({
  getMe: () => server.api.account.me({ user: server.user }),
}));

// Other slices' work: the page only places the threads and starts the live connection.
vi.mock("@/components/threads", () => ({
  SectionThreads: ({ sectionId }: { sectionId: string }) => (
    <div data-testid="section-threads">{sectionId}</div>
  ),
  ChangeThreads: ({ changeId }: { changeId: string }) => (
    <div data-testid="change-threads">{changeId}</div>
  ),
}));
vi.mock("@/data/live", () => ({ useChangeLive: () => ({ status: "offline" }) }));

const review = demoChanges.review;

/** The demo with something about it changed, so a state the demo does not hold can be shown. */
function demoWith(change: (data: DemoData) => void): DemoData {
  const data = structuredClone(demo);
  change(data);
  return data;
}

/** The demo with its one open comment resolved: only approvals stand between #12 and a merge. */
const commentsSettled = () =>
  demoWith((data) => {
    for (const thread of data.threads) {
      if (thread.status === "open" && thread.kind === "comment") thread.status = "resolved";
    }
  });

async function renderChange({
  as = demoUsers.maya,
  data = demo,
  changeId = review.id,
}: {
  as?: User;
  data?: DemoData;
  changeId?: typeof review.id;
} = {}) {
  server.api = createFixtureApi(data);
  server.user = as;
  server.diffRequests = 0;
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createRouter({
    routeTree: createRootRoute({ component: () => <ChangePage changeId={changeId} /> }),
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

const section = (title: string) => within(screen.getByRole("region", { name: title }));
const mergeCard = () => within(screen.getByRole("region", { name: "Merge readiness" }));
const blockers = () => mergeCard().getByRole("list", { name: "What blocks the merge" });

async function approve(title: string) {
  fireEvent.click(section(title).getByRole("button", { name: "Approve" }));
  await waitFor(() =>
    expect(section(title).getByRole("button", { name: "Withdraw my approval" })).toBeTruthy(),
  );
}

afterEach(cleanup);

describe("the change page, against the demo", () => {
  it("shows an approved, a pending and a withdrawn section as what they are", async () => {
    await renderChange();

    // Approved again after a push withdrew the first approval: both are in the history.
    const limit = section("Limit invites per workspace");
    expect(limit.getByText("Approved")).toBeTruthy();
    const limitHistory = within(limit.getByRole("list", { name: "Approval history" }));
    expect(limitHistory.getByText("Priya Raman approved")).toBeTruthy();
    expect(limitHistory.getByText("Priya Raman approved an earlier version")).toBeTruthy();
    expect(limitHistory.getByText(/a later push changed this section/)).toBeTruthy();

    // Nobody has approved it: no history at all.
    const route = section("Answer a limited request with 429");
    expect(route.getByText("Not approved yet")).toBeTruthy();
    expect(route.queryByRole("list", { name: "Approval history" })).toBeNull();

    // Approved once, then changed by the second push. It must not read as approved.
    const tests = section("Tests for the limit");
    expect(tests.getByText("Approval withdrawn")).toBeTruthy();
    expect(tests.queryByText("Approved")).toBeNull();
    const testsHistory = within(tests.getByRole("list", { name: "Approval history" }));
    expect(testsHistory.getByText("Maya Okafor approved an earlier version")).toBeTruthy();
    expect(testsHistory.getByText(/a later push changed this section/)).toBeTruthy();

    expect(screen.getByText("2 of 4 approved")).toBeTruthy();
  });

  it("puts sections in reading order, explanation first, with their threads", async () => {
    await renderChange();
    const titles = screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent);
    expect(titles.slice(0, 4)).toEqual([
      "Limit invites per workspace",
      "Answer a limited request with 429",
      "Tests for the limit",
      "Bindings and configuration",
    ]);
    expect(section("Answer a limited request with 429").getByText(/Retry-After/)).toBeTruthy();
    expect(screen.getAllByTestId("section-threads").map((el) => el.textContent)).toEqual([
      "sec_demo12limit",
      "sec_demo12route",
      "sec_demo12tests",
      "sec_demo12config",
    ]);
    expect(screen.getByTestId("change-threads").textContent).toBe(review.id);
  });

  it("keeps the diff one click away, and does not fetch it before", async () => {
    await renderChange();
    const route = section("Answer a limited request with 429");
    expect(route.queryByText("src/routes/invites.ts")).toBeNull();
    expect(server.diffRequests).toBe(0);

    fireEvent.click(route.getByRole("button", { name: "Read the diff" }));
    expect(await route.findByText("src/routes/invites.ts")).toBeTruthy();
    expect(server.diffRequests).toBe(1);

    fireEvent.click(route.getByRole("button", { name: "Hide the diff" }));
    expect(route.queryByText("src/routes/invites.ts")).toBeNull();
  });

  it("clears a blocker when a section is approved", async () => {
    await renderChange();
    expect(within(blockers()).getByText("2 sections still need an approval:")).toBeTruthy();
    expect(
      within(blockers()).getByRole("link", { name: "Answer a limited request with 429" }),
    ).toBeTruthy();

    await approve("Answer a limited request with 429");

    expect(section("Answer a limited request with 429").getByText("Approved")).toBeTruthy();
    expect(within(blockers()).getByText("1 section still needs an approval:")).toBeTruthy();
    expect(
      within(blockers()).queryByRole("link", { name: "Answer a limited request with 429" }),
    ).toBeNull();
    expect(within(blockers()).getByRole("link", { name: "Tests for the limit" })).toBeTruthy();
    expect(screen.getByText("3 of 4 approved")).toBeTruthy();
  });

  it("takes an approval back, and the blocker returns", async () => {
    await renderChange();
    await approve("Answer a limited request with 429");
    fireEvent.click(
      section("Answer a limited request with 429").getByRole("button", {
        name: "Withdraw my approval",
      }),
    );
    await waitFor(() =>
      expect(
        section("Answer a limited request with 429").getByText("Approval withdrawn"),
      ).toBeTruthy(),
    );
    expect(within(blockers()).getByText("2 sections still need an approval:")).toBeTruthy();
  });

  it("offers the merge only when the change is ready, and merges", async () => {
    await renderChange({ data: commentsSettled() });
    const mergeButton = () => mergeCard().queryByRole("button", { name: "Merge into main" });

    expect(mergeCard().getByText("not ready")).toBeTruthy();
    expect(mergeButton()).toBeNull();

    await approve("Answer a limited request with 429");
    expect(mergeButton()).toBeNull();

    await approve("Tests for the limit");
    expect(mergeCard().getByText("ready")).toBeTruthy();
    expect(mergeCard().queryByRole("list", { name: "What blocks the merge" })).toBeNull();

    const button = mergeButton();
    if (!button) throw new Error("the merge was not offered on a ready change");
    fireEvent.click(button);
    await waitFor(() => expect(mergeCard().getByText("merged")).toBeTruthy());
    expect(mergeButton()).toBeNull();
    // A merged change is no longer approved or re-run.
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Withdraw my approval" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Re-run/ })).toBeNull();
  });

  it("does not offer the merge while a comment is open, however many sections are approved", async () => {
    await renderChange();
    await approve("Answer a limited request with 429");
    await approve("Tests for the limit");
    expect(screen.getByText("4 of 4 approved")).toBeTruthy();
    expect(within(blockers()).getByText("1 comment is still open.")).toBeTruthy();
    expect(mergeCard().queryByRole("button", { name: "Merge into main" })).toBeNull();
  });

  it("shows an author's approval of their own change as a self-approval", async () => {
    await renderChange({ as: demoUsers.jonas });
    const route = section("Answer a limited request with 429");
    expect(route.getByText(/recorded as a self-approval/)).toBeTruthy();

    await approve("Answer a limited request with 429");

    expect(route.getByText("Approved by its author")).toBeTruthy();
    const history = within(route.getByRole("list", { name: "Approval history" }));
    expect(history.getByText("Jonas Lindqvist approved their own change")).toBeTruthy();
    expect(history.getByText("Self-approval")).toBeTruthy();
    // Someone else's approval is never marked as one.
    expect(section("Limit invites per workspace").queryByText("Self-approval")).toBeNull();
  });

  it("shows each stage's status, and re-running one sends the change back to the pipeline", async () => {
    await renderChange();
    const stages = within(screen.getByRole("list", { name: "Stages" }));
    expect(stages.getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      expect.stringMatching(/^Intent Skipped.*derived once/),
      expect.stringMatching(/^Sections Done/),
      expect.stringMatching(/^Review Done/),
      expect.stringMatching(/^CI Passed/),
    ]);

    fireEvent.click(stages.getByRole("button", { name: "Re-run CI" }));

    await waitFor(() => expect(stages.getByText("Queued, attempt 2")).toBeTruthy());
    expect(stages.queryByRole("button", { name: "Re-run CI" })).toBeNull();
    expect(screen.getByText("Pipeline running")).toBeTruthy();
    expect(
      within(blockers()).getByText("The pipeline is still working on the latest push."),
    ).toBeTruthy();
    expect(within(blockers()).getByText("CI has not finished.")).toBeTruthy();
  });

  it("says where the intent came from, and what the change cost", async () => {
    await renderChange();
    expect(screen.getByText(/cap invites at twenty per workspace per hour/)).toBeTruthy();
    expect(screen.getByText("Derived from the session's transcript.")).toBeTruthy();
    expect(screen.getByText("$2.44 so far.")).toBeTruthy();
    expect(screen.getByText(/An estimate/)).toBeTruthy();
    expect(screen.getByText("review $1.32")).toBeTruthy();
  });

  it("grades an intent derived without a transcript as one", async () => {
    await renderChange({
      data: demoWith((data) => {
        for (const intent of data.intents) intent.grade = "diff";
      }),
    });
    expect(screen.getByText("Derived from the diff alone.")).toBeTruthy();
    expect(screen.queryByText("Derived from the session's transcript.")).toBeNull();
  });
});

describe("the session's capture", () => {
  it("is present when every checkpoint the commits name arrived", async () => {
    await renderChange();
    expect(screen.getByText("The session was captured.")).toBeTruthy();
    expect(screen.getByText(`checkpoint ${demo.checkpoints[0]?.checkpointId}`)).toBeTruthy();
  });

  it("is missing when a named checkpoint never arrived", async () => {
    await renderChange({
      data: demoWith((data) => {
        data.checkpoints = [];
      }),
    });
    expect(screen.getByText("The capture is missing.")).toBeTruthy();
    expect(screen.getByText(`missing ${demo.checkpoints[0]?.checkpointId}`)).toBeTruthy();
    expect(screen.queryByText("The session was captured.")).toBeNull();
  });

  it("is pending while the pipeline still waits for a checkpoint", async () => {
    await renderChange({
      data: demoWith((data) => {
        data.checkpoints = [];
        for (const change of data.changes) if (change.id === review.id) change.status = "open";
      }),
    });
    expect(screen.getByText("Waiting for the capture.")).toBeTruthy();
    expect(screen.getByText(`awaiting ${demo.checkpoints[0]?.checkpointId}`)).toBeTruthy();
  });

  it("is none when the commits name no checkpoint", async () => {
    await renderChange({ changeId: demoChanges.cloud.id as typeof review.id });
    expect(screen.getByText("Nothing was captured.")).toBeTruthy();
  });
});

describe("a change the pipeline has not finished", () => {
  it("says why there is nothing to approve, and offers no merge", async () => {
    await renderChange({ changeId: demoChanges.cloud.id as typeof review.id });
    expect(screen.getByText("The change is still being divided into sections.")).toBeTruthy();
    expect(within(blockers()).getByText("There are no sections to approve yet.")).toBeTruthy();
    expect(mergeCard().queryByRole("button", { name: "Merge into main" })).toBeNull();
    // A stage that is still running cannot be run again.
    expect(screen.queryByRole("button", { name: "Re-run CI" })).toBeNull();
  });
});
