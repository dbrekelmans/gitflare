import type { ThreadId, User } from "@gitflare/core";
import {
  ChangeRef,
  DismissThreadInput,
  type ForgeApi,
  OpenThreadInput,
  PostMessageInput,
  ReclassifyThreadInput,
  RerunStageInput,
  SectionRef,
  ThreadRef,
} from "@gitflare/core/api";
import { type DemoData, demo, demoChanges, demoUsers } from "@gitflare/testing/demo";
import { createFixtureApi } from "@gitflare/testing/fixture-api";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { type ReactNode, Suspense } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { keys } from "@/data/keys";
import { FakeWebSocket } from "@/data/live.fake";
import { shortSha } from "@/lib/format";
import { ChangePage } from "@/routes/changes/-components/change-page";
import { ChangeThreads, SectionThreads } from "./index";

// The components are rendered for real, over the fixture API: what the server
// functions would call is called directly, as whoever the test signs in.
const server = vi.hoisted(() => ({
  api: undefined as unknown as ForgeApi,
  user: undefined as unknown as User,
  /** The name of the next server function to fail, as a server error would. */
  failNext: null as string | null,
}));

// A server function's result crosses the wire as a copy. The fixture hands out
// its own objects and changes them in place, so the copy is made here.
vi.mock("@/data/threads.functions", () => {
  const wire = async <T,>(name: string, result: () => Promise<T>) => {
    if (server.failNext === name) {
      server.failNext = null;
      throw new Error(`${name} failed on the server`);
    }
    return structuredClone(await result());
  };
  const ctx = () => ({ user: server.user });
  return {
    listThreads: ({ data }: { data: unknown }) =>
      wire("listThreads", () => server.api.threads.list(ctx(), ChangeRef.parse(data))),
    openThread: ({ data }: { data: unknown }) =>
      wire("openThread", () => server.api.threads.open(ctx(), OpenThreadInput.parse(data))),
    postMessage: ({ data }: { data: unknown }) =>
      wire("postMessage", () => server.api.threads.post(ctx(), PostMessageInput.parse(data))),
    resolveThread: ({ data }: { data: unknown }) =>
      wire("resolveThread", () => server.api.threads.resolve(ctx(), ThreadRef.parse(data))),
    dismissThread: ({ data }: { data: unknown }) =>
      wire("dismissThread", () =>
        server.api.threads.dismiss(ctx(), DismissThreadInput.parse(data)),
      ),
    reclassifyThread: ({ data }: { data: unknown }) =>
      wire("reclassifyThread", () =>
        server.api.threads.reclassify(ctx(), ReclassifyThreadInput.parse(data)),
      ),
    reopenThread: ({ data }: { data: unknown }) =>
      wire("reopenThread", () => server.api.threads.reopen(ctx(), ThreadRef.parse(data))),
  };
});

vi.mock("@/data/changes.functions", () => ({
  getChange: ({ data }: { data: unknown }) =>
    server.api.changes.get({ user: server.user }, ChangeRef.parse(data)),
  getSectionDiff: ({ data }: { data: unknown }) =>
    server.api.changes.sectionDiff({ user: server.user }, SectionRef.parse(data)),
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

// The live connection is the real one, over a fake socket: the test plays the server.
beforeEach(() => {
  FakeWebSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeWebSocket);
});

const review = demoChanges.review;
const sections = demo.sections.filter((section) => section.changeId === review.id);
const headSha = demo.changes.find((change) => change.id === review.id)?.headSha ?? "";

const ROLLOVER = "Nothing tests the window rolling over";
const KEY = "The counter is shared by every workspace";
const WINDOW = "A fixed window, where the queue uses a token bucket";
const CHAT = "Why not reuse the queue's limiter instead of adding a counter object?";

/** The demo with something about it changed, so a state the demo does not hold can be shown. */
function demoWith(change: (data: DemoData) => void): DemoData {
  const data = structuredClone(demo);
  change(data);
  return data;
}

/** The two components as the change page places them: one per section, then the change's own. */
function Placed() {
  return (
    <Suspense fallback={null}>
      {sections.map((section) => (
        <section key={section.id} aria-label={section.title}>
          <SectionThreads changeId={review.id} sectionId={section.id} />
        </section>
      ))}
      <section aria-label="Conversation">
        <ChangeThreads changeId={review.id} />
      </section>
    </Suspense>
  );
}

const current = { queryClient: new QueryClient() };

/** Someone else did something, and the live connection says the change moved. */
async function elsewhere(
  as: User,
  change: (api: ForgeApi, ctx: { user: User }) => Promise<unknown>,
) {
  await act(async () => {
    await change(server.api, { user: as });
    await current.queryClient.invalidateQueries({ queryKey: keys.changes.one(review.id) });
  });
}

async function renderOver(
  page: ReactNode,
  { as = demoUsers.maya, data = demo }: { as?: User; data?: DemoData } = {},
) {
  server.api = createFixtureApi(data);
  server.user = as;
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  current.queryClient = queryClient;
  const router = createRouter({
    routeTree: createRootRoute({ component: () => page }),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  render(
    <QueryClientProvider client={queryClient}>
      {/* biome-ignore lint/suspicious/noExplicitAny: a one-route router is not the app's registered one */}
      <RouterProvider router={router as any} />
    </QueryClientProvider>,
  );
  await screen.findByRole("article", { name: ROLLOVER });
}

const renderThreads = (options?: { as?: User; data?: DemoData }) => renderOver(<Placed />, options);

const region = (name: string) => within(screen.getByRole("region", { name }));
const thread = (title: string) => within(screen.getByRole("article", { name: title }));
const messages = (title: string) =>
  within(thread(title).getByRole("list", { name: "Messages" }))
    .getAllByRole("listitem")
    .map((item) => item.textContent);

function expand(title: string) {
  fireEvent.click(thread(title).getByRole("button", { expanded: false }));
}

function send(field: HTMLElement, body: string) {
  fireEvent.change(field, { target: { value: body } });
  const form = field.closest("form");
  if (!form) throw new Error("the field is not in a form");
  fireEvent.submit(form);
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  server.failNext = null;
});

/** What the change's live connection delivers about a reply being typed. */
const live = {
  type(threadId: string, text: string) {
    act(() =>
      FakeWebSocket.serving(review.id).receive({
        type: "signal",
        signal: { type: "thread.delta", threadId: threadId as ThreadId, text },
      }),
    );
  },
  /** The finished message arrives, and the draft gives way to it. */
  posted(threadId: string) {
    act(() =>
      FakeWebSocket.serving(review.id).receive({
        type: "event",
        event: {
          type: "thread.message",
          changeId: review.id,
          seq: 100,
          at: 0,
          threadId: threadId as ThreadId,
          messageSeq: 4,
        },
      }),
    );
  },
  discarded(threadId: string) {
    act(() =>
      FakeWebSocket.serving(review.id).receive({
        type: "signal",
        signal: { type: "thread.draft_discarded", threadId: threadId as ThreadId },
      }),
    );
  },
};

describe("the demo's four threads", () => {
  it("puts each thread where it belongs: comments in their section, the chat on the change", async () => {
    await renderThreads();
    const titles = (name: string) =>
      region(name)
        .queryAllByRole("article")
        .map((article) => article.getAttribute("aria-label"));

    expect(titles("Limit invites per workspace")).toEqual([KEY, WINDOW]);
    expect(titles("Tests for the limit")).toEqual([ROLLOVER]);
    expect(titles("Answer a limited request with 429")).toEqual([]);
    expect(titles("Conversation")).toEqual([CHAT]);
  });

  it("shows the open comment in full: the finding, its replies, what the review recorded, and the moves", async () => {
    await renderThreads();
    const open = thread(ROLLOVER);

    expect(open.getByRole("heading", { name: ROLLOVER })).toBeTruthy();
    expect(open.getByText("Open")).toBeTruthy();
    expect(messages(ROLLOVER)).toEqual([
      expect.stringMatching(/^gitflare · .* UTCThe tests cover reaching the limit/),
      expect.stringMatching(/^Jonas Lindqvist · .*I would rather not fake timers/),
      expect.stringMatching(/^gitflare · .*Shall I push that\?$/),
    ]);
    expect(open.getByText("tests · important")).toBeTruthy();
    expect(open.getByText("test/invites/rate-limit.test.ts:5–13")).toBeTruthy();
    expect(open.getByRole("button", { name: "Resolve" })).toBeTruthy();
    expect(open.getByRole("button", { name: "Dismiss…" })).toBeTruthy();
    expect(open.getByRole("textbox", { name: "Reply" })).toBeTruthy();
  });

  it("keeps the resolved comment to one line, and opened it shows what the agent did", async () => {
    await renderThreads();
    const resolved = thread(KEY);
    expect(resolved.getByText("resolved · 4 messages")).toBeTruthy();
    expect(resolved.queryByRole("list", { name: "Messages" })).toBeNull();

    expand(KEY);

    expect(resolved.getByText("Resolved")).toBeTruthy();
    expect(messages(KEY)).toHaveLength(4);
    // The agent's actions, on the replies that took them.
    expect(messages(KEY)[2]).toContain(`pushed fix ${shortSha(headSha)}`);
    expect(messages(KEY)[3]).toContain("resolved this comment");
    expect(resolved.getByText(/^By gitflare, /)).toBeTruthy();
    expect(resolved.getByText("src/invites/rate-limit.ts:15")).toBeTruthy();
    // Settled: it is reopened, not resolved or answered.
    expect(resolved.getByRole("button", { name: "Reopen" })).toBeTruthy();
    expect(resolved.queryByRole("button", { name: "Resolve" })).toBeNull();
    expect(resolved.queryByRole("textbox", { name: "Reply" })).toBeNull();

    fireEvent.click(resolved.getByRole("button", { name: "Collapse" }));
    expect(resolved.queryByRole("list", { name: "Messages" })).toBeNull();
  });

  it("shows the dismissed comment with its classification and the decision it recorded", async () => {
    await renderThreads();
    const dismissed = thread(WINDOW);
    expect(dismissed.getByText("dismissed as a design decision · 3 messages")).toBeTruthy();

    expand(WINDOW);

    expect(dismissed.getByText("Dismissed")).toBeTruthy();
    expect(dismissed.getByText("A design decision")).toBeTruthy();
    expect(messages(WINDOW)[2]).toContain("dismissed as a design decision");
    expect(dismissed.getByText(/^By Jonas Lindqvist, /)).toBeTruthy();
    expect(dismissed.getByRole("link", { name: "Read the decision" }).getAttribute("href")).toBe(
      "/decisions/dec_fixed_windows",
    );
    expect(dismissed.getByRole("button", { name: "Reclassify as not a problem" })).toBeTruthy();
  });

  it("shows the chat as a conversation that is never settled", async () => {
    await renderThreads();
    const chat = thread(CHAT);
    expect(messages(CHAT)).toEqual([
      expect.stringMatching(/^Priya Raman · .*Why not reuse the queue's limiter/),
      expect.stringMatching(/^gitflare · .*The session considered it first/),
    ]);
    expect(chat.getByText(/does not hold up the merge/)).toBeTruthy();
    expect(chat.queryByText("Open")).toBeNull();
    expect(chat.queryByRole("button", { name: "Resolve" })).toBeNull();
    expect(chat.queryByRole("button", { name: "Dismiss…" })).toBeNull();
    expect(chat.getByRole("textbox", { name: "Reply" })).toBeTruthy();
  });
});

describe("working on a thread", () => {
  it("adds a reply to the thread and empties the field", async () => {
    await renderThreads();
    const field = thread(ROLLOVER).getByRole("textbox", { name: "Reply" }) as HTMLInputElement;

    send(field, "Yes, push that.");

    await waitFor(() => expect(messages(ROLLOVER)).toHaveLength(4));
    expect(messages(ROLLOVER)[3]).toMatch(/^Maya Okafor · .*Yes, push that\.$/);
    expect(messages(CHAT)).toHaveLength(2);
    await waitFor(() => expect(field.value).toBe(""));
  });

  it("refuses an empty reply without sending it", async () => {
    await renderThreads();
    send(thread(ROLLOVER).getByRole("textbox", { name: "Reply" }), "   ");

    expect(await thread(ROLLOVER).findByText("Write a message first.")).toBeTruthy();
    expect(messages(ROLLOVER)).toHaveLength(3);
  });

  it("resolves a comment, and reopens it", async () => {
    await renderThreads();
    const comment = thread(ROLLOVER);

    fireEvent.click(comment.getByRole("button", { name: "Resolve" }));

    await waitFor(() => expect(comment.getByText("Resolved")).toBeTruthy());
    expect(comment.queryByText("Open")).toBeNull();
    expect(comment.queryByRole("button", { name: "Resolve" })).toBeNull();
    expect(comment.queryByRole("textbox", { name: "Reply" })).toBeNull();
    // The reader settled it here, so it stays open in front of them.
    expect(messages(ROLLOVER)).toHaveLength(3);

    fireEvent.click(comment.getByRole("button", { name: "Reopen" }));

    await waitFor(() => expect(comment.getByText("Open")).toBeTruthy());
    expect(comment.getByRole("button", { name: "Resolve" })).toBeTruthy();
  });

  it("dismisses a comment only with a reason, under the classification chosen", async () => {
    await renderThreads();
    const comment = thread(ROLLOVER);
    fireEvent.click(comment.getByRole("button", { name: "Dismiss…" }));
    const form = within(comment.getByRole("form", { name: "Dismiss this comment" }));

    fireEvent.click(form.getByRole("button", { name: "Dismiss the comment" }));
    expect(await form.findByText("Say why, in a sentence.")).toBeTruthy();
    expect(comment.getByText("Open")).toBeTruthy();

    fireEvent.click(form.getByRole("radio", { name: "A design decision" }));
    fireEvent.change(form.getByRole("textbox", { name: "Reason" }), {
      target: { value: "Rollover is covered by the limiter's own suite." },
    });
    fireEvent.click(form.getByRole("button", { name: "Dismiss the comment" }));

    await waitFor(() => expect(comment.getByText("Dismissed")).toBeTruthy());
    expect(comment.getByText("A design decision")).toBeTruthy();
    expect(comment.queryByRole("form", { name: "Dismiss this comment" })).toBeNull();
    expect(messages(ROLLOVER)[3]).toMatch(
      /^Maya Okafor · .*Rollover is covered by the limiter's own suite\.$/,
    );
    expect(comment.getByText(/^By Maya Okafor, /)).toBeTruthy();
  });

  it("dismisses as not a problem unless told otherwise, and can be talked out of it", async () => {
    await renderThreads();
    const comment = thread(ROLLOVER);
    fireEvent.click(comment.getByRole("button", { name: "Dismiss…" }));
    fireEvent.click(comment.getByRole("button", { name: "Keep it open" }));
    expect(comment.queryByRole("form", { name: "Dismiss this comment" })).toBeNull();
    expect(comment.getByRole("textbox", { name: "Reply" })).toBeTruthy();

    fireEvent.click(comment.getByRole("button", { name: "Dismiss…" }));
    const form = within(comment.getByRole("form", { name: "Dismiss this comment" }));
    fireEvent.change(form.getByRole("textbox", { name: "Reason" }), {
      target: { value: "The arithmetic is trivial." },
    });
    fireEvent.click(form.getByRole("button", { name: "Dismiss the comment" }));

    await waitFor(() => expect(comment.getByText("Dismissed")).toBeTruthy());
    expect(comment.getByText("Not a problem")).toBeTruthy();
    expect(comment.getByRole("button", { name: "Reclassify as a design decision" })).toBeTruthy();
  });

  it("reclassifies a dismissal", async () => {
    await renderThreads();
    const dismissed = thread(WINDOW);
    expand(WINDOW);

    fireEvent.click(dismissed.getByRole("button", { name: "Reclassify as not a problem" }));

    await waitFor(() => expect(dismissed.getByText("Not a problem")).toBeTruthy());
    expect(dismissed.getByText("Dismissed")).toBeTruthy();
    expect(dismissed.queryByText("A design decision")).toBeNull();
    // It no longer stands as a decision, so it does not point at one.
    expect(dismissed.queryByRole("link", { name: "Read the decision" })).toBeNull();
    expect(dismissed.getByRole("button", { name: "Reclassify as a design decision" })).toBeTruthy();
  });

  it("starts a chat about the change", async () => {
    await renderThreads();
    const question = "Does the limit apply to invites sent through the API?";

    send(region("Conversation").getByRole("textbox", { name: "Ask about this change" }), question);

    const chat = within(await region("Conversation").findByRole("article", { name: question }));
    expect(chat.getByRole("list", { name: "Messages" }).textContent).toMatch(
      /^Maya Okafor · .*through the API\?$/,
    );
    expect(chat.getByText(/does not hold up the merge/)).toBeTruthy();
    expect(region("Conversation").getAllByRole("article")).toHaveLength(2);
  });

  it("starts a chat about one section, and it stays with that section", async () => {
    await renderThreads();
    const config = region("Bindings and configuration");
    const question = "Why a new binding rather than the existing one?";
    expect(config.queryByRole("textbox")).toBeNull();

    fireEvent.click(config.getByRole("button", { name: "Ask about this section" }));
    send(config.getByRole("textbox", { name: "Ask about this section" }), question);

    expect(await config.findByRole("article", { name: question })).toBeTruthy();
    expect(region("Conversation").queryByRole("article", { name: question })).toBeNull();
  });
});

describe("a reply being typed", () => {
  const rollover = "thr_demo12rollover" as ThreadId;
  const draft = (title: string) => thread(title).queryByRole("listitem", { name: /being written/ });

  it("appears in its thread as it grows, and gives way to the finished message", async () => {
    await renderThreads();
    expect(draft(ROLLOVER)).toBeNull();

    live.type(rollover, "Pushing");
    expect(draft(ROLLOVER)?.textContent).toContain("Pushing");
    expect(draft(CHAT)).toBeNull();

    live.type(rollover, "Pushing the change now.");
    expect(draft(ROLLOVER)?.textContent).toContain("Pushing the change now.");
    // It is not a message yet, and the reader can still write.
    expect(thread(ROLLOVER).getByRole("textbox", { name: "Reply" })).toBeTruthy();

    live.posted(rollover);
    expect(draft(ROLLOVER)).toBeNull();
    expect(messages(ROLLOVER)).toHaveLength(3);
  });

  it("goes when the agent's turn is discarded, and no message replaces it", async () => {
    await renderThreads();
    live.type(rollover, "Half a reply");
    expect(draft(ROLLOVER)).not.toBeNull();

    live.discarded(rollover);

    expect(draft(ROLLOVER)).toBeNull();
    expect(messages(ROLLOVER)).toHaveLength(3);
  });

  it("is set as the finished message will be, so it does not reflow when it lands", async () => {
    await renderThreads();
    live.type(rollover, "Pass the clock to `takeInviteSlot`.");

    expect(draft(ROLLOVER)?.querySelector("code")?.textContent).toBe("takeInviteSlot");
    expect(draft(ROLLOVER)?.textContent).not.toContain("`");
  });

  it("opens a collapsed thread while the agent writes to it", async () => {
    await renderThreads();
    expect(thread(KEY).queryByRole("list", { name: "Messages" })).toBeNull();

    live.type("thr_demo12key", "On reflection");

    expect(draft(KEY)?.textContent).toContain("On reflection");
    expect(messages(KEY)).toHaveLength(5);
  });
});

describe("a change that is merged or closed", () => {
  it("shows its threads without anything to do to them", async () => {
    await renderThreads({
      data: demoWith((data) => {
        for (const change of data.changes) if (change.id === review.id) change.status = "merged";
      }),
    });
    expand(KEY);
    expand(WINDOW);

    expect(messages(ROLLOVER)).toHaveLength(3);
    expect(screen.queryByRole("textbox")).toBeNull();
    for (const name of [
      "Resolve",
      "Dismiss…",
      "Reopen",
      "Reclassify as not a problem",
      "Ask about this section",
    ]) {
      expect(screen.queryByRole("button", { name })).toBeNull();
    }
  });
});

describe("on the change page", () => {
  const mergeCard = () => within(screen.getByRole("region", { name: "Merge readiness" }));

  it("renders the threads inside their sections and under the conversation", async () => {
    await renderOver(<ChangePage changeId={review.id} />);
    expect(region("Tests for the limit").getByRole("article", { name: ROLLOVER })).toBeTruthy();
    expect(region("Limit invites per workspace").getAllByRole("article")).toHaveLength(2);
    expect(screen.getByRole("article", { name: CHAT })).toBeTruthy();
  });

  it("clears the merge blocker when the open comment is resolved, and restores it on reopening", async () => {
    await renderOver(<ChangePage changeId={review.id} />);
    expect(mergeCard().getByText("1 comment is still open.")).toBeTruthy();

    fireEvent.click(thread(ROLLOVER).getByRole("button", { name: "Resolve" }));

    await waitFor(() => expect(mergeCard().queryByText("1 comment is still open.")).toBeNull());
    expect(thread(ROLLOVER).getByText("Resolved")).toBeTruthy();

    fireEvent.click(thread(ROLLOVER).getByRole("button", { name: "Reopen" }));
    await waitFor(() => expect(mergeCard().getByText("1 comment is still open.")).toBeTruthy());
  });

  it("clears the merge blocker when the open comment is dismissed", async () => {
    await renderOver(<ChangePage changeId={review.id} />);
    const comment = thread(ROLLOVER);
    fireEvent.click(comment.getByRole("button", { name: "Dismiss…" }));
    fireEvent.change(comment.getByRole("textbox", { name: "Reason" }), {
      target: { value: "Covered elsewhere." },
    });
    fireEvent.click(comment.getByRole("button", { name: "Dismiss the comment" }));

    await waitFor(() => expect(mergeCard().queryByText("1 comment is still open.")).toBeNull());
    expect(comment.getByText("Dismissed")).toBeTruthy();
  });
});

describe("what others do to a thread", () => {
  it("opens a collapsed thread that someone else reopens, since it holds up the merge again", async () => {
    await renderThreads();
    expect(thread(KEY).queryByRole("button", { name: "Resolve" })).toBeNull();

    await elsewhere(demoUsers.jonas, (api, ctx) =>
      api.threads.reopen(ctx, { threadId: "thr_demo12key" as ThreadId }),
    );

    await waitFor(() => expect(thread(KEY).getByText("Open")).toBeTruthy());
    expect(thread(KEY).getByRole("button", { name: "Resolve" })).toBeTruthy();
    expect(thread(KEY).getByRole("textbox", { name: "Reply" })).toBeTruthy();
  });

  it("names the person who settled a thread, though they never posted in it", async () => {
    await renderThreads({
      data: demoWith((data) => {
        for (const t of data.threads)
          if (t.id === "thr_demo12key") t.settledBy = demoUsers.priya.id;
      }),
    });
    expand(KEY);
    expect(messages(KEY).some((text) => text?.startsWith("Priya Raman"))).toBe(false);

    expect(thread(KEY).getByText(/^By Priya Raman, /)).toBeTruthy();
  });
});

describe("a move that fails", () => {
  it("says so, and the next move that succeeds clears it", async () => {
    await renderThreads();
    const dismissed = thread(WINDOW);
    expand(WINDOW);
    server.failNext = "reclassifyThread";

    fireEvent.click(dismissed.getByRole("button", { name: "Reclassify as not a problem" }));
    expect((await dismissed.findByRole("alert")).textContent).toContain("reclassifyThread failed");

    fireEvent.click(dismissed.getByRole("button", { name: "Reopen" }));

    await waitFor(() => expect(dismissed.getByText("Open")).toBeTruthy());
    expect(dismissed.queryByRole("alert")).toBeNull();
  });
});
