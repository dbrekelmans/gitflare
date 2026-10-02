import { type Section, sectionContentHash } from "@gitflare/core";
import { schema } from "@gitflare/db";
import { placeholderResponder } from "@gitflare/testing";
import { demoFiles, demoUsers } from "@gitflare/testing/demo";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { runSectionsStage, type SectionsDeps } from "./stage";
import {
  type DemoWorld,
  demoAtFirstPush,
  divisionReply,
  fixtureSection,
  review,
} from "./testing/demo";

const { maya, priya } = demoUsers;

/** Runs the stage for the demo's first push, with the model dividing it as the fixture has it. */
async function firstPushSectioned(world: DemoWorld): Promise<Section[]> {
  const diff = await world.diffAt(review.first);
  world.ports.models.reply("sections", { output: divisionReply(diff, review.sections) });
  await runSectionsStage(world.deps, world.input(review.first));
  return world.sections();
}

/** New wording for the sections a push changed, keyed as the prompt labels them. */
function revisionReply(wording: Record<string, { title: string; explanation: string }>) {
  return { output: { sections: wording } };
}

/** Runs the stage for both of the demo's pushes, leaving the sections as the fixture has them. */
async function secondPushSectioned(world: DemoWorld): Promise<Section[]> {
  await firstPushSectioned(world);
  await world.head(review.second);
  world.ports.models.reply(
    "sections",
    revisionReply({
      s1: { title: "Limit invites per workspace", explanation: "Per workspace." },
      s3: { title: "Tests for the limit", explanation: "Three tests." },
    }),
  );
  await runSectionsStage(world.deps, world.input(review.second));
  return world.sections();
}

/** Every changed file, with the sections that present it. */
function sectionsByFile(paths: string[], sections: Section[]): Record<string, number> {
  return Object.fromEntries(
    paths.map((path) => [
      path,
      sections.filter((section) => section.files.some((file) => file.path === path)).length,
    ]),
  );
}

describe("the first revision", () => {
  it("puts every changed file in exactly one section", async () => {
    const world = await demoAtFirstPush();
    const diff = await world.diffAt(review.first);

    const sections = await firstPushSectioned(world);

    expect(diff).toHaveLength(7);
    expect(
      Object.values(
        sectionsByFile(
          diff.map((file) => file.path),
          sections,
        ),
      ),
    ).toEqual(diff.map(() => 1));
  });

  it("stores what the model wrote, hashed against the revision's diff", async () => {
    const world = await demoAtFirstPush();
    const diff = await world.diffAt(review.first);

    const sections = await firstPushSectioned(world);

    expect(sections.map(({ title, kind, explanation }) => ({ title, kind, explanation }))).toEqual(
      review.sections.map(({ title, kind, explanation }) => ({ title, kind, explanation })),
    );
    for (const section of sections) {
      expect(section.contentHash).toBe(sectionContentHash(diff, section.files));
      expect(section.createdRevisionId).toBe(review.first.id);
      expect(section.updatedRevisionId).toBe(review.first.id);
    }
    expect(await world.events()).toEqual([{ type: "sections.updated" }]);
  });

  it("orders sections by kind, behaviour first, whatever order the model gave", async () => {
    const world = await demoAtFirstPush();
    const diff = await world.diffAt(review.first);
    world.ports.models.reply("sections", {
      output: divisionReply(diff, [...review.sections].reverse()),
    });

    await runSectionsStage(world.deps, world.input(review.first));

    const sections = await world.sections();
    expect(sections.map((section) => section.kind)).toEqual([
      "behaviour",
      "behaviour",
      "tests",
      "mechanical",
    ]);
    expect(sections.map((section) => section.position)).toEqual([0, 1, 2, 3]);
  });

  it("gives the model the change, the session and every file's diff, as the sections agent", async () => {
    const world = await demoAtFirstPush();

    await firstPushSectioned(world);

    const [call] = world.ports.models.calls;
    const message = call?.messages[0]?.content ?? "";
    expect(call?.attribution).toEqual({
      agent: "sections",
      userId: review.change.authorId,
      repositoryId: review.change.repositoryId,
      changeId: review.change.id,
      sessionId: review.change.sessionId,
    });
    expect(message).toContain("Rate-limit the invite endpoint");
    expect(message).toContain("Cap invites at 20 an hour per workspace");
    expect(message).toContain("Test the invite limit");
    expect(message).toContain('<file path="src/invites/rate-limit.ts" status="added"');
    expect(message).toContain("+export async function takeInviteSlot");
    // The system prompt asks for the shape the reply is validated against.
    expect(call?.system).toContain('"files": {"<path>": number}');
  });

  it("says so when no session was captured", async () => {
    const world = await demoAtFirstPush();
    world.ports.capture.captures.clear();

    await firstPushSectioned(world);

    expect(world.ports.models.calls[0]?.messages[0]?.content).toContain(
      "this session was not captured",
    );
  });

  it.each([
    [
      "leaves a file out",
      (reply: ReturnType<typeof divisionReply>) => {
        const { "wrangler.jsonc": _left, ...files } = reply.files;
        return { ...reply, files };
      },
    ],
    [
      "names a section that does not exist",
      (reply: ReturnType<typeof divisionReply>) => ({
        ...reply,
        files: { ...reply.files, "wrangler.jsonc": 9 },
      }),
    ],
    [
      "has a section with no files",
      (reply: ReturnType<typeof divisionReply>) => ({
        ...reply,
        files: { ...reply.files, "src/routes/invites.ts": 1 },
      }),
    ],
    [
      "has a kind that is not one",
      (reply: ReturnType<typeof divisionReply>) => ({
        ...reply,
        sections: reply.sections.map((section) => ({ ...section, kind: "refactor" })),
      }),
    ],
  ])("fails, and writes nothing, on a reply that %s", async (_what, spoil) => {
    const world = await demoAtFirstPush();
    const diff = await world.diffAt(review.first);
    world.ports.models.reply("sections", { output: spoil(divisionReply(diff, review.sections)) });

    await expect(runSectionsStage(world.deps, world.input(review.first))).rejects.toThrow(
      /could not be used to divide this change into sections/,
    );

    expect(await world.sections()).toEqual([]);
    expect(await world.events()).toEqual([]);
  });

  it("fails on a reply that is not the JSON it asked for", async () => {
    const world = await demoAtFirstPush();
    world.ports.models.reply("sections", { text: "Here are the sections you asked for." });

    await expect(runSectionsStage(world.deps, world.input(review.first))).rejects.toThrow(
      /could not be used/,
    );
  });

  it("divides with the local placeholder model, which knows nothing about the change", async () => {
    const world = await demoAtFirstPush();
    world.ports.models.respond(placeholderResponder((s) => z.toJSONSchema(s)));
    const diff = await world.diffAt(review.first);

    const outcome = await runSectionsStage(world.deps, world.input(review.first));

    const sections = await world.sections();
    expect(outcome).toEqual({ status: "succeeded" });
    expect(sections).toHaveLength(1);
    expect(sections[0]?.files.map((file) => file.path)).toEqual(diff.map((file) => file.path));
  });

  it("is skipped once a later push has replaced the revision", async () => {
    const world = await demoAtFirstPush();
    await world.head(review.second);

    const outcome = await runSectionsStage(world.deps, world.input(review.first));

    expect(outcome).toEqual({ status: "skipped", reason: "A later push replaced this revision." });
    expect(world.ports.models.calls).toEqual([]);
    expect(await world.sections()).toEqual([]);
  });
});

describe("the second revision", () => {
  /** The demo after its first push was sectioned and all four sections were approved. */
  async function approvedThenPushed() {
    const world = await demoAtFirstPush();
    const before = await firstPushSectioned(world);
    const at = (id: Parameters<typeof fixtureSection>[1]) => fixtureSection(before, id);
    const given = {
      limit: await world.approve(at("sec_demo12limit"), priya),
      route: await world.approve(at("sec_demo12route"), maya),
      tests: await world.approve(at("sec_demo12tests"), maya),
      config: await world.approve(at("sec_demo12config"), priya),
    };
    await world.head(review.second);
    world.ports.clock.advance(60_000);
    world.ports.models.reply(
      "sections",
      revisionReply({
        s1: { title: "Limit invites per workspace", explanation: "The counter is per workspace." },
        s3: { title: "Tests for the limit", explanation: "Three tests now." },
      }),
    );
    const eventsBefore = (await world.events()).length;
    return { world, before, given, eventsBefore, at };
  }

  it("moves the two sections the push changed and leaves the other two as they were", async () => {
    const { world, before, at } = await approvedThenPushed();

    await runSectionsStage(world.deps, world.input(review.second));

    const after = await world.sections();
    const diff = await world.diffAt(review.second);
    expect(after.map((section) => section.id)).toEqual(before.map((section) => section.id));
    expect(
      after.map((section, index) => section.contentHash !== before[index]?.contentHash),
    ).toEqual([true, false, true, false]);
    expect(after.map((section) => section.contentHash)).toEqual(
      after.map((section) => sectionContentHash(diff, section.files)),
    );
    // The fixture records the same two sections as updated by the second push.
    expect(after.map((section) => section.updatedRevisionId)).toEqual(
      review.sections.map((section) => section.updatedRevisionId),
    );
    expect(fixtureSection(after, "sec_demo12route")).toEqual(at("sec_demo12route"));
    expect(fixtureSection(after, "sec_demo12config")).toEqual(at("sec_demo12config"));
  });

  it("withdraws exactly the approvals of the sections whose content changed", async () => {
    const { world, given } = await approvedThenPushed();

    await runSectionsStage(world.deps, world.input(review.second));

    const approvals = await world.approvals();
    const byId = (id: string) => approvals.find((approval) => approval.id === id);
    const now = world.ports.clock.now();
    for (const withdrawn of [given.limit, given.tests]) {
      expect(byId(withdrawn.id)).toEqual({
        ...withdrawn,
        withdrawnAt: now,
        withdrawnReason: "content_changed",
      });
    }
    expect(byId(given.route.id)).toEqual(given.route);
    expect(byId(given.config.id)).toEqual(given.config);
  });

  it("emits a withdrawal for each of them, and that the sections changed", async () => {
    const { world, given, eventsBefore } = await approvedThenPushed();

    await runSectionsStage(world.deps, world.input(review.second));

    expect((await world.events()).slice(eventsBefore)).toEqual([
      { type: "section.approval_withdrawn", sectionId: given.limit.sectionId, userId: priya.id },
      { type: "section.approval_withdrawn", sectionId: given.tests.sectionId, userId: maya.id },
      { type: "sections.updated" },
    ]);
    // What was stored was also sent to the browsers watching.
    expect(world.ports.live.types(review.change.id).slice(-3)).toEqual([
      "section.approval_withdrawn",
      "section.approval_withdrawn",
      "sections.updated",
    ]);
  });

  it("asks the model to reword only the sections that moved, showing it their diffs", async () => {
    const { world, before } = await approvedThenPushed();

    await runSectionsStage(world.deps, world.input(review.second));

    const after = await world.sections();
    expect(after.map((section) => section.explanation)).toEqual([
      "The counter is per workspace.",
      before[1]?.explanation,
      "Three tests now.",
      before[3]?.explanation,
    ]);
    expect(world.ports.models.calls).toHaveLength(2);
    const message = world.ports.models.calls[1]?.messages[0]?.content ?? "";
    const toRewrite = message.slice(message.indexOf("<sections_to_rewrite>"));
    expect(toRewrite).toContain('<section id="s1" kind="behaviour">');
    expect(toRewrite).toContain('<section id="s3" kind="tests">');
    expect(toRewrite).not.toContain('<section id="s2"');
    expect(toRewrite).toContain("at most LIMIT invites per workspace per hour");
    expect(toRewrite).not.toContain("src/routes/invites.ts");
    // The push's own commit is told apart from the earlier ones.
    expect(message).toContain('<commit push="latest">\nCount invites per workspace');
    expect(message).toContain('<commit push="earlier">\nRate-limit invites per hour');
  });

  it("fails, and withdraws nothing, when the new wording does not cover a moved section", async () => {
    const world = await demoAtFirstPush();
    const before = await firstPushSectioned(world);
    await world.approve(fixtureSection(before, "sec_demo12limit"), priya);
    await world.head(review.second);
    world.ports.models.reply(
      "sections",
      revisionReply({ s1: { title: "Limit invites", explanation: "Per workspace." } }),
    );
    const snapshot = await world.snapshot();

    await expect(runSectionsStage(world.deps, world.input(review.second))).rejects.toThrow(
      /could not be used to bring the changed sections' explanations up to date/,
    );

    expect(await world.snapshot()).toEqual(snapshot);
  });

  it("folds with the local placeholder model too", async () => {
    const world = await demoAtFirstPush();
    await firstPushSectioned(world);
    await world.head(review.second);
    world.ports.models.respond(placeholderResponder((s) => z.toJSONSchema(s)));
    const diff = await world.diffAt(review.second);

    const outcome = await runSectionsStage(world.deps, world.input(review.second));

    expect(outcome).toEqual({ status: "succeeded" });
    for (const section of await world.sections()) {
      expect(section.contentHash).toBe(sectionContentHash(diff, section.files));
    }
  });
});

describe("running the stage twice for one revision", () => {
  it("changes nothing the second time, on the first revision", async () => {
    const world = await demoAtFirstPush();
    await firstPushSectioned(world);
    const snapshot = await world.snapshot();
    const published = world.ports.live.events.length;

    // No reply is scripted: a second call to the model would fail the run.
    const outcome = await runSectionsStage(world.deps, world.input(review.first));

    expect(outcome).toEqual({ status: "succeeded" });
    expect(await world.snapshot()).toEqual(snapshot);
    expect(world.ports.live.events).toHaveLength(published);
    expect(world.ports.models.calls).toHaveLength(1);
  });

  it("changes nothing the second time, on a later revision", async () => {
    const world = await demoAtFirstPush();
    const before = await firstPushSectioned(world);
    await world.approve(fixtureSection(before, "sec_demo12limit"), priya);
    await world.approve(fixtureSection(before, "sec_demo12config"), priya);
    await world.head(review.second);
    world.ports.models.reply(
      "sections",
      revisionReply({
        s1: { title: "Limit invites per workspace", explanation: "Per workspace." },
        s3: { title: "Tests for the limit", explanation: "Three tests." },
      }),
    );
    await runSectionsStage(world.deps, world.input(review.second));
    const snapshot = await world.snapshot();
    const published = world.ports.live.events.length;
    world.ports.clock.advance(60_000);

    const outcome = await runSectionsStage(world.deps, world.input(review.second));

    expect(outcome).toEqual({ status: "succeeded" });
    expect(await world.snapshot()).toEqual(snapshot);
    expect(world.ports.live.events).toHaveLength(published);
    expect(world.ports.models.calls).toHaveLength(2);
  });
});

describe("a push that lands while the model is answering", () => {
  /** Runs `during` inside the stage's next call to the model, before the model replies. */
  function whileTheModelAnswers(world: DemoWorld, during: () => Promise<unknown>): SectionsDeps {
    const { models } = world.ports;
    let ran = false;
    return {
      ...world.deps,
      models: {
        embed: (request) => models.embed(request),
        stream: (request) => models.stream(request),
        generate: async (request) => {
          if (!ran) {
            ran = true;
            await during();
          }
          return models.generate(request);
        },
      },
    };
  }

  it("leaves the sections to the later revision's run, and writes nothing of its own", async () => {
    const world = await demoAtFirstPush();
    const first = await world.diffAt(review.first);
    const second = await world.diffAt(review.second);
    // The later revision's run asks first, so its reply is first in the queue.
    world.ports.models
      .reply("sections", { output: divisionReply(second, review.sections) })
      .reply("sections", { output: divisionReply(first, review.sections) });
    const deps = whileTheModelAnswers(world, async () => {
      await world.head(review.second);
      await runSectionsStage(world.deps, world.input(review.second));
    });

    const outcome = await runSectionsStage(deps, world.input(review.first));

    expect(outcome).toEqual({ status: "skipped", reason: "A later push replaced this revision." });
    const sections = await world.sections();
    expect(sections).toHaveLength(4);
    expect(
      sectionsByFile(
        second.map((file) => file.path),
        sections,
      ),
    ).toEqual(Object.fromEntries(second.map((file) => [file.path, 1])));
    for (const section of sections) {
      expect(section.contentHash).toBe(sectionContentHash(second, section.files));
    }
    // No removed leftovers either: these four and the merged change's one are every row.
    expect((await world.snapshot()).sections).toHaveLength(5);
    expect(await world.events()).toEqual([{ type: "sections.updated" }]);
  });

  it("withdraws no approval for a revision that is no longer the head", async () => {
    const world = await demoAtFirstPush();
    const before = await firstPushSectioned(world);
    const approval = await world.approve(fixtureSection(before, "sec_demo12limit"), priya);
    await world.head(review.second);
    world.ports.models.reply(
      "sections",
      revisionReply({
        s1: { title: "Limit invites per workspace", explanation: "Per workspace." },
        s3: { title: "Tests for the limit", explanation: "Three tests." },
      }),
    );
    const snapshot = await world.snapshot();
    const deps = whileTheModelAnswers(world, () => world.push({ "notes.md": "later\n" }));

    const outcome = await runSectionsStage(deps, world.input(review.second));

    expect(outcome).toEqual({ status: "skipped", reason: "A later push replaced this revision." });
    expect(await world.snapshot()).toEqual(snapshot);
    expect((await world.approvals()).find((a) => a.id === approval.id)).toEqual(approval);
  });

  /** Runs `during` after the stage's last look at the change and before its writes commit. */
  function whileCommitting(world: DemoWorld, during: () => Promise<unknown>): SectionsDeps {
    let ran = false;
    const db = new Proxy(world.db, {
      get(target, property) {
        if (property === "batch") {
          return async (...args: Parameters<typeof target.batch>) => {
            if (!ran) {
              ran = true;
              await during();
            }
            return target.batch(...args);
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    return { ...world.deps, db };
  }

  it("commits no section when the push lands just as it writes", async () => {
    const world = await demoAtFirstPush();
    const diff = await world.diffAt(review.first);
    world.ports.models.reply("sections", { output: divisionReply(diff, review.sections) });
    const snapshot = await world.snapshot();
    const deps = whileCommitting(world, () => world.head(review.second));

    const outcome = await runSectionsStage(deps, world.input(review.first));

    expect(outcome).toEqual({ status: "skipped", reason: "A later push replaced this revision." });
    expect(await world.snapshot()).toEqual(snapshot);
  });

  it("commits no fold and no withdrawal when the push lands just as it writes", async () => {
    const world = await demoAtFirstPush();
    const before = await firstPushSectioned(world);
    await world.approve(fixtureSection(before, "sec_demo12limit"), priya);
    await world.head(review.second);
    world.ports.models.reply(
      "sections",
      revisionReply({
        s1: { title: "Limit invites per workspace", explanation: "Per workspace." },
        s3: { title: "Tests for the limit", explanation: "Three tests." },
      }),
    );
    const deps = whileCommitting(world, () => world.push({ "notes.md": "later\n" }));
    const snapshot = await world.snapshot();

    const outcome = await runSectionsStage(deps, world.input(review.second));

    expect(outcome).toEqual({ status: "skipped", reason: "A later push replaced this revision." });
    // The later push's own revision row is the only thing that changed.
    expect(await world.snapshot()).toEqual(snapshot);
  });

  it("fails rather than add to sections another run of the same revision wrote", async () => {
    const world = await demoAtFirstPush();
    const diff = await world.diffAt(review.first);
    world.ports.models
      .reply("sections", { output: divisionReply(diff, review.sections) })
      .reply("sections", { output: divisionReply(diff, review.sections) });
    const deps = whileTheModelAnswers(world, () =>
      runSectionsStage(world.deps, world.input(review.first)),
    );

    await expect(runSectionsStage(deps, world.input(review.first))).rejects.toThrow(
      /changed by another run of this stage/,
    );

    expect(await world.sections()).toHaveLength(4);
    expect(await world.events()).toEqual([{ type: "sections.updated" }]);
  });
});

describe("a push that adds files", () => {
  const added = {
    "src/invites/audit.ts": "export const auditInvite = () => {};\n",
    "docs/invites.md": "# Invites\n",
  };

  async function pushedWithNewFiles() {
    const world = await demoAtFirstPush();
    await secondPushSectioned(world);
    const before = await world.sections();
    const approvals = {
      limit: await world.approve(fixtureSection(before, "sec_demo12limit"), priya),
      route: await world.approve(fixtureSection(before, "sec_demo12route"), maya),
    };
    const third = await world.push(added);
    return { world, before, approvals, third };
  }

  it("places each where the model says: in an existing section or a new one", async () => {
    const { world, before, approvals, third } = await pushedWithNewFiles();
    world.ports.models
      .reply("sections", {
        output: {
          newSections: [{ title: "Document invites", kind: "supporting", explanation: "A page." }],
          placements: { "docs/invites.md": "new1", "src/invites/audit.ts": "s1" },
        },
      })
      .reply(
        "sections",
        revisionReply({ s1: { title: "Limit and audit invites", explanation: "Now audited." } }),
      );

    await runSectionsStage(world.deps, world.input(third));

    const after = await world.sections();
    const diff = await world.diffAt(third);
    expect(
      sectionsByFile(
        diff.map((file) => file.path),
        after,
      ),
    ).toEqual(Object.fromEntries(diff.map((file) => [file.path, 1])));
    // The new section is read after the behaviour it supports and before the tests.
    expect(after.map((section) => section.title)).toEqual([
      "Limit and audit invites",
      "Answer a limited request with 429",
      "Document invites",
      "Tests for the limit",
      "Bindings and configuration",
    ]);
    expect(after.map((section) => section.position)).toEqual([0, 1, 2, 3, 4]);
    expect(after[2]).toMatchObject({
      kind: "supporting",
      files: [{ path: "docs/invites.md", hunkHashes: [] }],
      createdRevisionId: third.id,
      updatedRevisionId: third.id,
    });
    expect(after[0]?.updatedRevisionId).toBe(third.id);
    for (const section of after) {
      expect(section.contentHash).toBe(sectionContentHash(diff, section.files));
    }
    // Only the section that received a file lost its approval.
    const standing = (await world.approvals()).filter((a) => a.withdrawnAt === null);
    expect(standing.map((a) => a.id)).toEqual([approvals.route.id]);
    // Sections that neither moved nor received anything are byte for byte what they were.
    expect(after[1]).toEqual(before[1]);
    expect(after[3]).toEqual({ ...before[2], position: 3 });
  });

  it("shows the model the sections that exist and only the files to place", async () => {
    const { world, third } = await pushedWithNewFiles();
    world.ports.models.respond(placeholderResponder((s) => z.toJSONSchema(s)));

    await runSectionsStage(world.deps, world.input(third));

    const place = world.ports.models.calls.at(-2);
    const message = place?.messages[0]?.content ?? "";
    const toPlace = message.slice(message.indexOf("<files_to_place>"));
    expect(place?.output?.name).toBe("section_placement");
    expect(message).toContain('<section id="s4" kind="mechanical">');
    expect(toPlace).toContain('<file path="docs/invites.md" status="added"');
    expect(toPlace).toContain('<file path="src/invites/audit.ts" status="added"');
    expect(toPlace).not.toContain("src/invites/rate-limit.ts");
  });

  it.each([
    ["an unknown section", { newSections: [], placements: { a: "s9", b: "s1" } }],
    ["a new section it did not describe", { newSections: [], placements: { a: "new1", b: "s1" } }],
    [
      "a new section left empty",
      {
        newSections: [{ title: "Docs", kind: "supporting", explanation: "A page." }],
        placements: { a: "s1", b: "s1" },
      },
    ],
    ["a file left out", { newSections: [], placements: { a: "s1" } }],
  ])("fails, and writes nothing, on a placement with %s", async (_what, reply) => {
    const { world, third } = await pushedWithNewFiles();
    const { a, b } = reply.placements as { a: string; b?: string };
    world.ports.models.reply("sections", {
      output: {
        newSections: reply.newSections,
        placements: { "docs/invites.md": a, ...(b && { "src/invites/audit.ts": b }) },
      },
    });
    const snapshot = await world.snapshot();

    await expect(runSectionsStage(world.deps, world.input(third))).rejects.toThrow(
      /could not be used to place the files this push added/,
    );

    expect(await world.snapshot()).toEqual(snapshot);
  });
});

describe("a push that takes a section's files back out", () => {
  it("removes the section, withdraws its approvals and says why", async () => {
    const world = await demoAtFirstPush();
    const before = await secondPushSectioned(world);
    const route = fixtureSection(before, "sec_demo12route");
    const config = fixtureSection(before, "sec_demo12config");
    const lost = await world.approve(route, maya);
    const kept = await world.approve(config, priya);
    const third = await world.push({
      "src/routes/invites.ts": demoFiles.base["src/routes/invites.ts"] ?? "",
    });
    const eventsBefore = (await world.events()).length;

    const outcome = await runSectionsStage(world.deps, world.input(third));

    expect(outcome).toEqual({ status: "succeeded" });
    expect((await world.sections()).map((section) => section.id)).not.toContain(route.id);
    const [row] = await world.db
      .select()
      .from(schema.sections)
      .where(eq(schema.sections.id, route.id));
    expect(row?.removedAt).toBe(world.ports.clock.now());
    const approvals = await world.approvals();
    expect(approvals.find((a) => a.id === lost.id)).toMatchObject({
      withdrawnAt: world.ports.clock.now(),
      withdrawnReason: "section_removed",
    });
    expect(approvals.find((a) => a.id === kept.id)).toEqual(kept);
    expect((await world.events()).slice(eventsBefore)).toEqual([
      { type: "section.approval_withdrawn", sectionId: route.id, userId: maya.id },
      { type: "sections.updated" },
    ]);
    // Taking a section away needs nothing from the model: no call beyond the two pushes'.
    expect(world.ports.models.calls).toHaveLength(2);
  });
});

describe("a change with no diff", () => {
  it("is skipped, with the reason", async () => {
    const world = await demoAtFirstPush();
    const empty = { ...review.first, headSha: review.first.baseSha };
    await world.db
      .update(schema.revisions)
      .set({ headSha: empty.headSha })
      .where(eq(schema.revisions.id, empty.id));

    const outcome = await runSectionsStage(world.deps, world.input(empty));

    expect(outcome).toEqual({
      status: "skipped",
      reason: "This revision changes no files, so there is nothing to divide.",
    });
    expect(world.ports.models.calls).toEqual([]);
  });
});
