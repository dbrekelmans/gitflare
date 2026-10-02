import { createTestDb } from "@gitflare/db/testing";
import { appendMessage } from "@gitflare/review";
import { createFakePorts, ManualClock } from "@gitflare/testing";
import { buildDemoGit, demo, demoChanges, demoUsers } from "@gitflare/testing/demo";
import { createFixtureApi } from "@gitflare/testing/fixture-api";
import { seedDemo } from "@gitflare/testing/seed";
import { describe, expect, it } from "vitest";
import type { Services } from "../services";
import { threadsApi } from "./threads";

const maya = { user: demoUsers.maya };
const priya = { user: demoUsers.priya };
const changeId = demoChanges.review.id;

/** The slice over a seeded database, with the thread's writer wired as the forge wires it, minus the Durable Object. */
async function demoSlice() {
  const db = createTestDb();
  await seedDemo(db);
  const ports = createFakePorts({ git: buildDemoGit().git, clock: new ManualClock(demo.now) });
  const services: Services = { ...ports, db, mode: "production" };
  services.threads = { post: (threadId, message) => appendMessage(services, threadId, message) };
  return { api: threadsApi(services), ports };
}

describe("the threads slice", () => {
  it("returns the demo's threads from the seeded database, as the fixture does", async () => {
    const { api } = await demoSlice();

    const listed = await api.list(maya, { changeId });

    expect(listed).toEqual(await createFixtureApi().threads.list(maya, { changeId }));
    expect(listed.map((view) => view.thread.id)).toEqual([
      "thr_demo12key",
      "thr_demo12window",
      "thr_demo12rollover",
      "thr_demo12queue",
    ]);
    expect(listed[0]?.messages.map((message) => message.user?.name ?? "agent")).toEqual([
      "agent",
      "Jonas Lindqvist",
      "agent",
      "agent",
    ]);
    expect(await api.list(maya, { changeId: demoChanges.merged.id })).toEqual([]);
    await expect(api.list(maya, { changeId: "chg_nowhere" })).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("opens a thread with the caller's first message, and takes replies in order", async () => {
    const { api, ports } = await demoSlice();

    const opened = await api.open(priya, {
      changeId,
      kind: "comment",
      anchor: { path: "src/routes/invites.ts", side: "head", startLine: 3, endLine: 4 },
      body: "Should this be behind the flag?",
    });

    expect(opened.thread).toMatchObject({
      kind: "comment",
      origin: "human",
      status: "open",
      // Placed in the section that presents the anchored file.
      sectionId: "sec_demo12route",
      anchorRevisionId: demoChanges.review.headRevisionId,
      createdBy: priya.user.id,
      messageCount: 1,
    });
    expect(opened.messages).toMatchObject([
      { seq: 1, body: "Should this be behind the flag?", user: { name: "Priya Raman" } },
    ]);

    const replied = await api.post(maya, { threadId: opened.thread.id, body: "No, ship it." });
    expect(replied.messages.map((message) => [message.seq, message.user?.name])).toEqual([
      [1, "Priya Raman"],
      [2, "Maya Okafor"],
    ]);
    expect(ports.live.types(changeId)).toEqual([
      "thread.opened",
      "thread.message",
      "thread.message",
    ]);
    expect(await api.list(maya, { changeId })).toHaveLength(5);

    await expect(api.post(maya, { threadId: "thr_nowhere", body: "hello" })).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(
      api.open(priya, { changeId, kind: "chat", sectionId: "sec_demo11queue", body: "hello" }),
    ).rejects.toMatchObject({ code: "invalid" });
  });

  it("settles, reclassifies and reopens a comment", async () => {
    const { api } = await demoSlice();
    const threadId = "thr_demo12rollover";

    const dismissed = await api.dismiss(priya, {
      threadId,
      classification: "not_a_problem",
      reason: "The boundary is covered by the counter's own tests.",
    });
    expect(dismissed.thread).toMatchObject({
      status: "dismissed",
      dismissal: "not_a_problem",
      settledBy: priya.user.id,
    });
    expect(dismissed.messages.at(-1)).toMatchObject({
      body: "The boundary is covered by the counter's own tests.",
      user: { id: priya.user.id },
    });

    const reopened = await api.reopen(maya, { threadId });
    expect(reopened.thread).toMatchObject({ status: "open", dismissal: null, settledBy: null });
    const resolved = await api.resolve(maya, { threadId });
    expect(resolved.thread).toMatchObject({ status: "resolved", settledBy: maya.user.id });
    await expect(
      api.reclassify(maya, { threadId, classification: "not_a_problem" }),
    ).rejects.toMatchObject({ code: "conflict" });
  });
});
