import { type CloudSessionEvent, ForgeError, forkRepoName, type Session } from "@gitflare/core";
import type { Sandbox, SandboxHost } from "@gitflare/core/ports";
import { schema } from "@gitflare/db";
import { createTestDb } from "@gitflare/db/testing";
import { createDemoPorts } from "@gitflare/testing";
import { demo } from "@gitflare/testing/demo";
import { seedDemo } from "@gitflare/testing/seed";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { agentCommand } from "./agent";
import { createCloudSessions } from "./cloud-sessions";

const gatewayBaseUrl = "https://gateway.ai.cloudflare.com/v1/account/gitflare/anthropic";
const workspace = {
  image: "cloudflare/debian-trixie",
  snapshot: { id: "snap_workspace", image: "cloudflare/debian-trixie" },
};
const sha = "3f1c9a7e5b2d4f6081a2b3c4d5e6f708192a3b4c";

const [repository] = demo.repositories;
if (!repository) throw new Error("the demo has no repository");

/** A hosted session whose fork is ready and which nothing was pushed from. */
const fresh: Session = {
  id: "ses_fresh",
  repositoryId: repository.id,
  userId: demo.viewer.id,
  kind: "cloud",
  status: "active",
  title: "Add audit log export!",
  forkRepo: forkRepoName(repository.slug, "ses_fresh"),
  baseSha: demo.git.shas.base,
  createdAt: demo.now,
  forkReadyAt: demo.now,
  endedAt: null,
  forkDeletedAt: null,
};
const sandboxId = "sbx_fresh";

/**
 * The fake sandbox host with some of a sandbox's methods replaced. The fake
 * cannot show a process that is still running, and answers after a stop where
 * the real controller throws `unavailable`; the tests for those two cases put
 * that behaviour in front of it.
 */
function overriding(
  host: SandboxHost,
  overrides: (sandbox: Sandbox) => Partial<Sandbox>,
): SandboxHost {
  return {
    get(id) {
      const sandbox = host.get(id);
      return {
        id,
        start: (options) => sandbox.start(options),
        isRunning: () => sandbox.isRunning(),
        exec: (command, options) => sandbox.exec(command, options),
        spawn: (name, command, options) => sandbox.spawn(name, command, options),
        processStatus: (name) => sandbox.processStatus(name),
        readLog: (name, stream, offset) => sandbox.readLog(name, stream, offset),
        writeFile: (path, content) => sandbox.writeFile(path, content),
        readFile: (path) => sandbox.readFile(path),
        snapshot: () => sandbox.snapshot(),
        stop: () => sandbox.stop(),
        ...overrides(sandbox),
      };
    },
  };
}

async function setup(
  options: {
    prepared?: boolean;
    session?: Partial<Session>;
    sandboxes?: (host: SandboxHost) => SandboxHost;
  } = {},
) {
  const db = createTestDb();
  await seedDemo(db);
  const ports = createDemoPorts();
  const { git, sandboxes, clock } = ports;
  if (options.prepared ?? true) {
    await db
      .update(schema.organisations)
      .set({ settings: { ...demo.organisation.settings, workspace } });
  }
  const session = { ...fresh, ...options.session };
  await db.insert(schema.sessions).values(session);
  await git.forkRepo(demo.git.repos.main, session.forkRepo);

  /** Scripts what the next turns print: one stream per turn, in order. */
  const streams: string[] = [];
  sandboxes.on((command) =>
    command.kind === "spawn" ? { stdout: streams.shift() ?? "" } : undefined,
  );

  const sessions = createCloudSessions({
    db,
    git,
    sandboxes: options.sandboxes?.(sandboxes) ?? sandboxes,
    clock,
    gatewayBaseUrl,
  });
  return {
    db,
    git,
    sandboxes,
    clock,
    sessions,
    streams,
    turns: () => sandboxes.commands.filter((command) => command.kind === "spawn"),
    checkouts: () =>
      sandboxes.commands.filter((command) => command.command[3] === "gitflare-checkout"),
  };
}

/** A line of a turn's stream: something the agent printed, stamped. */
function agent(at: number, event: unknown): string {
  return `${JSON.stringify({ at, agent: JSON.stringify(event) })}\n`;
}

function says(at: number, text: string): string {
  return agent(at, { type: "assistant", message: { content: [{ type: "text", text }] } });
}

function uses(at: number, name: string, input: unknown): string {
  return agent(at, {
    type: "assistant",
    message: { content: [{ type: "tool_use", name, input }] },
  });
}

/** What an event says, whatever its type. */
function detail(event: CloudSessionEvent): string {
  switch (event.type) {
    case "prompt":
    case "assistant":
      return event.text;
    case "tool":
      return event.name;
    case "pushed":
      return event.sha;
    case "state":
      return event.state;
    case "error":
      return event.message;
  }
}

async function rejection(promise: Promise<unknown>): Promise<ForgeError> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  if (!(error instanceof ForgeError)) throw new Error(`expected a ForgeError, got ${error}`);
  return error;
}

describe("launch", () => {
  it("starts the prepared workspace with a git grant for the fork and a model grant, and nothing else", async () => {
    const { sessions, sandboxes } = await setup();

    await sessions.launch(fresh.id, "Add an export");

    expect(sandboxes.startOptions(sandboxId)).toEqual({
      ...workspace,
      instance: "standard-1",
      egress: [
        { kind: "git", repo: fresh.forkRepo, scope: "write" },
        {
          kind: "models",
          attribution: {
            agent: "session",
            userId: fresh.userId,
            repositoryId: fresh.repositoryId,
            sessionId: fresh.id,
          },
        },
      ],
    });
  });

  it("checks out the fork as the session's owner, then runs the agent command in the checkout", async () => {
    const { sessions, sandboxes, git } = await setup();

    await sessions.launch(fresh.id, "Add an export");

    const [checkout, turn, ...rest] = sandboxes.commands;
    expect(rest).toEqual([]);
    const fork = await git.getRepo(fresh.forkRepo);
    expect(checkout?.kind).toBe("exec");
    expect(checkout?.command.slice(3)).toEqual([
      "gitflare-checkout",
      fork?.remote,
      "/workspace",
      "add-audit-log-export-fresh",
      demo.viewer.name,
      demo.viewer.email,
    ]);

    const expected = agentCommand({
      prompt: "Add an export",
      model: demo.organisation.settings.models.session,
      gatewayBaseUrl,
    });
    // Named after the prompt's place in the log.
    expect(turn).toMatchObject({ kind: "spawn", name: "turn-2" });
    expect(turn?.command.slice(0, 2)).toEqual(["bash", "-c"]);
    expect(turn?.command.slice(3)).toEqual([
      "gitflare-turn",
      "add-audit-log-export-fresh",
      "3600",
      ...expected.command,
    ]);
    expect(turn?.options.cwd).toBe("/workspace");
    expect(turn?.options.env).toEqual(expected.env);
    // The script stops the agent itself, with time left to push what it committed.
    expect(turn?.options.timeoutSeconds).toBeGreaterThan(3600 + 60);
  });

  it("puts no credential in the sandbox", async () => {
    const { sessions, sandboxes, git } = await setup();

    await sessions.launch(fresh.id, "Add an export");

    expect(git.tokens).toEqual([]);
    const everything = JSON.stringify([sandboxes.commands, sandboxes.startOptions(sandboxId)]);
    expect(everything).not.toMatch(/art_v\d|Bearer|cf-aig/);
  });

  it("yields the agent's events in order and skips malformed lines", async () => {
    const { sessions, streams, clock } = await setup();
    const started = clock.now();
    streams.push(
      [
        agent(started + 1_000, { type: "system", subtype: "init" }),
        uses(started + 2_000, "Grep", { pattern: "audit_log" }),
        "not json at all\n",
        '{"at": 3000, "agent": \n',
        uses(started + 4_000, "Write", { file_path: "src/audit/export.ts", content: "…" }),
        `${JSON.stringify({ at: started + 5_000, prompt: "a prompt nobody wrote" })}\n`,
        says(started + 6_000, "Added `exportAuditLog`."),
        agent(started + 7_000, { type: "result", is_error: false, result: "Added." }),
        `${JSON.stringify({ at: started + 8_000, pushed: sha })}\n`,
      ].join(""),
    );

    await sessions.launch(fresh.id, "Add an export");

    const sessionId = fresh.id;
    expect(await sessions.events(sessionId, 0)).toEqual([
      { sessionId, seq: 1, at: started, type: "state", state: "starting" },
      { sessionId, seq: 2, at: started, type: "prompt", text: "Add an export" },
      { sessionId, seq: 3, at: started, type: "state", state: "working" },
      { sessionId, seq: 4, at: started + 2_000, type: "tool", name: "Grep", summary: "audit_log" },
      {
        sessionId,
        seq: 5,
        at: started + 4_000,
        type: "tool",
        name: "Write",
        summary: "src/audit/export.ts",
      },
      {
        sessionId,
        seq: 6,
        at: started + 6_000,
        type: "assistant",
        text: "Added `exportAuditLog`.",
      },
      { sessionId, seq: 7, at: started + 8_000, type: "pushed", sha },
      { sessionId, seq: 8, at: started + 8_000, type: "state", state: "idle" },
    ]);
    expect((await sessions.events(sessionId, 6)).map((event) => event.seq)).toEqual([7, 8]);
    expect(await sessions.status(sessionId)).toEqual({
      sessionId,
      state: "idle",
      error: null,
      updatedAt: started + 8_000,
    });
  });

  it("is safe to call twice", async () => {
    const { sessions, turns, checkouts } = await setup();

    await sessions.launch(fresh.id, "Add an export");
    await sessions.launch(fresh.id, "Add an export");

    expect(checkouts()).toHaveLength(1);
    expect(turns()).toHaveLength(1);
  });

  it("does not send the first prompt again after a stop", async () => {
    const { sessions, turns, checkouts } = await setup();
    await sessions.launch(fresh.id, "Add an export");
    await sessions.stop(fresh.id);

    await sessions.launch(fresh.id, "Add an export");

    expect(turns()).toHaveLength(1);
    expect(checkouts()).toHaveLength(1);
    expect((await sessions.status(fresh.id)).state).toBe("asleep");
  });

  it("starts the agent a launch recorded the prompt for but was cut off before starting", async () => {
    let cut = true;
    const { sessions, turns } = await setup({
      sandboxes: (host) =>
        overriding(host, (sandbox) => ({
          spawn: async (name, command, options) => {
            if (!cut) return sandbox.spawn(name, command, options);
            cut = false;
            throw new Error("the request was cancelled");
          },
        })),
    });
    await expect(sessions.launch(fresh.id, "Add an export")).rejects.toThrow("cancelled");
    expect(turns()).toHaveLength(0);

    await sessions.launch(fresh.id, "Add an export");
    await sessions.launch(fresh.id, "Add an export");

    expect(turns().map((turn) => [turn.name, turn.command.at(-1)])).toEqual([
      ["turn-2", "Add an export"],
    ]);
    expect((await sessions.events(fresh.id, 0)).map(detail)).toEqual([
      "starting",
      "Add an export",
      "working",
      "idle",
    ]);
  });

  it("works on a branch of its own, whatever its title", async () => {
    const { sessions, checkouts } = await setup({ session: { title: "Main" } });
    await sessions.launch(fresh.id, "Add an export");
    expect(checkouts()[0]?.command[6]).toBe("main-fresh");
  });

  it("finishes a launch that was cut off during the checkout", async () => {
    const { sessions, sandboxes, turns, checkouts } = await setup();
    let cut = true;
    sandboxes.on((command) => {
      if (command.kind !== "exec" || !cut) return undefined;
      cut = false;
      throw new Error("the request was cancelled");
    });

    await expect(sessions.launch(fresh.id, "Add an export")).rejects.toThrow("cancelled");
    expect((await sessions.status(fresh.id)).state).toBe("starting");
    expect((await rejection(sessions.prompt(fresh.id, "Too early"))).code).toBe("not_ready");

    await sessions.launch(fresh.id, "Add an export");

    expect(checkouts()).toHaveLength(2);
    expect(turns()).toHaveLength(1);
    expect((await sessions.status(fresh.id)).state).toBe("idle");
  });

  it("fails with the reason when the workspace has not been prepared", async () => {
    const { sessions, sandboxes } = await setup({ prepared: false });

    const error = await rejection(sessions.launch(fresh.id, "Add an export"));

    expect(error.code).toBe("unavailable");
    expect(error.message).toMatch(/has not been prepared/);
    expect(sandboxes.startOptions(sandboxId)).toBeNull();
  });

  it("fails clearly when the fork is missing or still being copied", async () => {
    const missing = await setup();
    await missing.git.deleteRepo(fresh.forkRepo);
    const gone = await rejection(missing.sessions.launch(fresh.id, "Add an export"));
    expect(gone.code).toBe("not_found");
    expect(gone.message).toContain(fresh.forkRepo);

    const copying = await setup();
    copying.git.holdCopies = true;
    await copying.git.deleteRepo(fresh.forkRepo);
    await copying.git.forkRepo(demo.git.repos.main, fresh.forkRepo);
    expect((await rejection(copying.sessions.launch(fresh.id, "Add an export"))).code).toBe(
      "not_ready",
    );

    const unrecorded = await setup({ session: { forkReadyAt: null } });
    expect((await rejection(unrecorded.sessions.launch(fresh.id, "Add an export"))).code).toBe(
      "not_ready",
    );

    for (const { sandboxes } of [missing, copying, unrecorded]) {
      expect(sandboxes.startOptions(sandboxId)).toBeNull();
    }
  });

  it("refuses a session that is not a running hosted one", async () => {
    const ended = await setup({ session: { status: "abandoned", endedAt: demo.now } });
    expect((await rejection(ended.sessions.launch(fresh.id, "Add an export"))).code).toBe(
      "conflict",
    );

    const local = await setup({ session: { kind: "local" } });
    expect((await rejection(local.sessions.launch(fresh.id, "Add an export"))).code).toBe(
      "invalid",
    );

    const { sessions, sandboxes } = await setup();
    expect((await rejection(sessions.launch("ses_unknown", "Add an export"))).code).toBe(
      "not_found",
    );
    expect((await rejection(sessions.launch(fresh.id, "  "))).code).toBe("invalid");
    expect(sandboxes.startOptions(sandboxId)).toBeNull();
  });

  it("reports a failed checkout, and a later prompt starts over", async () => {
    const { sessions, sandboxes, clock, turns } = await setup();
    let broken = true;
    sandboxes.on((command) =>
      command.kind === "exec" && broken
        ? { exitCode: 128, stderr: "fatal: unable to access the fork: 403\n" }
        : undefined,
    );
    const started = clock.now();

    const error = await rejection(sessions.launch(fresh.id, "Add an export"));

    expect(error.code).toBe("unavailable");
    const message =
      "The session's fork could not be checked out: fatal: unable to access the fork: 403";
    expect(error.message).toBe(message);
    expect(turns()).toEqual([]);
    expect(await sessions.status(fresh.id)).toEqual({
      sessionId: fresh.id,
      state: "failed",
      error: message,
      updatedAt: started,
    });
    expect(await sessions.events(fresh.id, 0)).toMatchObject([
      { seq: 1, type: "state", state: "starting" },
      { seq: 2, type: "error", message },
      { seq: 3, type: "state", state: "failed" },
    ]);

    broken = false;
    await sessions.prompt(fresh.id, "Try again");

    expect(turns()).toHaveLength(1);
    expect(await sessions.status(fresh.id)).toMatchObject({ state: "idle", error: null });
  });
});

describe("prompt", () => {
  it("continues the conversation in the same sandbox", async () => {
    const { sessions, streams, turns, checkouts, clock } = await setup();
    const first = clock.now();
    streams.push(
      says(first + 1_000, "Added the export."),
      says(first + 61_000, "Added the route."),
    );

    await sessions.launch(fresh.id, "Add an export");
    const second = clock.advance(60_000);
    await sessions.prompt(fresh.id, "Now the route");

    expect(checkouts()).toHaveLength(1);
    const [, turn] = turns();
    expect(turn?.name).toBe("turn-6");
    expect(turn?.command).toContain("--continue");
    expect(turn?.command.at(-1)).toBe("Now the route");
    expect(turns()[0]?.command).not.toContain("--continue");

    expect(
      (await sessions.events(fresh.id, 0)).map((event) => [
        event.seq,
        event.at,
        event.type,
        detail(event),
      ]),
    ).toEqual([
      [1, first, "state", "starting"],
      [2, first, "prompt", "Add an export"],
      [3, first, "state", "working"],
      [4, first + 1_000, "assistant", "Added the export."],
      [5, first + 1_000, "state", "idle"],
      [6, second, "prompt", "Now the route"],
      [7, second, "state", "working"],
      [8, first + 61_000, "assistant", "Added the route."],
      [9, first + 61_000, "state", "idle"],
    ]);
  });

  it("is refused while the agent is still working, which shows as working", async () => {
    let running = false;
    const { sessions, streams, turns, clock } = await setup({
      sandboxes: (host) =>
        overriding(host, (sandbox) => ({
          processStatus: async (name) =>
            running ? { state: "running" } : sandbox.processStatus(name),
        })),
    });
    const started = clock.now();
    // The last line is still being written.
    streams.push(`${says(started + 1_000, "Reading the code.")}{"at": 17909`);
    await sessions.launch(fresh.id, "Add an export");
    running = true;

    expect(await sessions.status(fresh.id)).toMatchObject({
      state: "working",
      updatedAt: started + 1_000,
    });
    expect((await sessions.events(fresh.id, 0)).map((event) => event.type)).toEqual([
      "state",
      "prompt",
      "state",
      "assistant",
    ]);
    const error = await rejection(sessions.prompt(fresh.id, "And the route"));
    expect(error.code).toBe("conflict");
    expect(turns()).toHaveLength(1);

    running = false;
    await sessions.prompt(fresh.id, "And the route");
    expect(turns()).toHaveLength(2);
  });

  it("says so when the agent stopped without reporting why", async () => {
    const { sessions, sandboxes, streams, clock } = await setup();
    const started = clock.now();
    let exitCode = 1;
    sandboxes.on((command) =>
      command.kind === "spawn" ? { exitCode, stdout: streams.shift() ?? "" } : undefined,
    );
    const failure = (events: CloudSessionEvent[]) =>
      events.filter((event) => event.type === "error").map(detail);

    streams.push(says(started + 1_000, "Starting."));
    await sessions.launch(fresh.id, "Add an export");
    expect(failure(await sessions.events(fresh.id, 0))).toEqual([
      "The agent stopped unexpectedly (exit code 1).",
    ]);
    expect(await sessions.status(fresh.id)).toMatchObject({ state: "idle", error: null });

    // A failure the agent reported itself is not reported twice.
    streams.push(
      agent(started + 2_000, { type: "result", is_error: true, result: "API Error: 402" }),
    );
    await sessions.prompt(fresh.id, "Again");
    expect(failure(await sessions.events(fresh.id, 5))).toEqual(["API Error: 402"]);

    exitCode = 124;
    await sessions.prompt(fresh.id, "Once more");
    expect(failure(await sessions.events(fresh.id, 10))).toEqual([
      "The agent was stopped: it ran out of time.",
    ]);
  });

  it("ends a turn whose agent could not be started, and says why", async () => {
    const { sessions, sandboxes, turns } = await setup();
    await sessions.launch(fresh.id, "Add an export");
    let refused = true;
    sandboxes.on((command) => {
      if (command.kind !== "spawn" || !refused) return undefined;
      refused = false;
      throw new ForgeError("unavailable", "The sandbox was lost: connection reset");
    });

    await expect(sessions.prompt(fresh.id, "Now the route")).rejects.toThrow("was lost");

    expect((await sessions.events(fresh.id, 4)).map(detail)).toEqual([
      "Now the route",
      "working",
      "The agent could not be started: The sandbox was lost: connection reset",
      "idle",
    ]);
    expect((await sessions.status(fresh.id)).state).toBe("idle");
    await sessions.prompt(fresh.id, "Now the route");
    expect(turns().at(-1)?.name).toBe("turn-9");
  });

  it("ends a turn that was recorded but never started, once it has had time to start", async () => {
    // The request is cut off between recording the prompt and starting the
    // agent, and the sandbox cannot be asked whether it did.
    let cut = false;
    let unanswered = false;
    const { sessions, clock, turns } = await setup({
      sandboxes: (host) =>
        overriding(host, (sandbox) => ({
          spawn: async (name, command, options) => {
            if (!cut) return sandbox.spawn(name, command, options);
            cut = false;
            unanswered = true;
            throw new Error("cut");
          },
          processStatus: async (name) => {
            if (!unanswered) return sandbox.processStatus(name);
            unanswered = false;
            throw new Error("the request was cancelled");
          },
        })),
    });
    await sessions.launch(fresh.id, "Add an export");
    cut = true;
    await expect(sessions.prompt(fresh.id, "Now the route")).rejects.toThrow("cut");
    // The sandbox could not say whether it started: it might yet.
    expect((await sessions.status(fresh.id)).state).toBe("working");
    expect((await rejection(sessions.prompt(fresh.id, "And this"))).code).toBe("conflict");

    clock.advance(5 * 60_000 + 1);

    expect((await sessions.status(fresh.id)).state).toBe("idle");
    expect((await sessions.events(fresh.id, 4)).map(detail)).toEqual([
      "Now the route",
      "working",
      "The agent never started. Send the prompt again.",
      "idle",
    ]);
    await sessions.prompt(fresh.id, "Now the route");
    expect(turns()).toHaveLength(2);
  });

  it("continues the agent's conversation only once it has one", async () => {
    const { sessions, sandboxes, streams, turns, clock } = await setup();
    // The first turn dies before the agent says anything.
    let exitCode = 1;
    sandboxes.on((command) =>
      command.kind === "spawn" ? { exitCode, stdout: streams.shift() ?? "" } : undefined,
    );
    await sessions.launch(fresh.id, "Add an export");
    exitCode = 0;
    streams.push(says(clock.now() + 1_000, "Added it."));
    await sessions.prompt(fresh.id, "Try again");
    await sessions.prompt(fresh.id, "Now the route");

    expect(turns().map((turn) => turn.command.includes("--continue"))).toEqual([
      false,
      false,
      true,
    ]);
  });

  it("is refused before the session was launched", async () => {
    const { sessions, sandboxes } = await setup();
    expect((await rejection(sessions.prompt(fresh.id, "Hello"))).code).toBe("not_ready");
    expect(sandboxes.startOptions(sandboxId)).toBeNull();
  });
});

describe("reading the log", () => {
  it("records each event once, however often and however concurrently it is read", async () => {
    let running = true;
    const { sessions, streams, clock } = await setup({
      sandboxes: (host) =>
        overriding(host, (sandbox) => ({
          processStatus: async (name) =>
            running ? { state: "running" } : sandbox.processStatus(name),
        })),
    });
    streams.push(`${says(clock.now() + 1_000, "Reading.")}${says(clock.now() + 2_000, "Done.")}`);
    await sessions.launch(fresh.id, "Add an export");

    await Promise.all([sessions.events(fresh.id, 0), sessions.events(fresh.id, 0)]);
    running = false;
    await Promise.all([
      sessions.events(fresh.id, 0),
      sessions.status(fresh.id),
      sessions.events(fresh.id, 0),
    ]);

    const events = await sessions.events(fresh.id, 0);
    expect(events.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(events.map(detail)).toEqual([
      "starting",
      "Add an export",
      "working",
      "Reading.",
      "Done.",
      "idle",
    ]);
  });

  it("does not read a finished turn's output again", async () => {
    let reads = 0;
    const { sessions, streams, clock } = await setup({
      sandboxes: (host) =>
        overriding(host, (sandbox) => ({
          readLog: (name, stream, offset) => {
            reads++;
            return sandbox.readLog(name, stream, offset);
          },
        })),
    });
    streams.push(says(clock.now() + 1_000, "Added the export."));
    await sessions.launch(fresh.id, "Add an export");
    await sessions.events(fresh.id, 0);
    const once = reads;

    await sessions.events(fresh.id, 0);
    await sessions.status(fresh.id);

    expect(once).toBeGreaterThan(0);
    expect(reads).toBe(once);
  });
});

describe("a start that was cut off", () => {
  it("is started again once its checkout has had time to finish", async () => {
    let cut = false;
    const { sessions, clock, turns, checkouts } = await setup({
      sandboxes: (host) =>
        overriding(host, (sandbox) => ({
          exec: async (command, options) => {
            if (!cut) return sandbox.exec(command, options);
            cut = false;
            throw new Error("the request was cancelled");
          },
        })),
    });
    await sessions.launch(fresh.id, "Add an export");
    // A resume: the workspace is rebuilt, and the request dies during the checkout.
    await sessions.stop(fresh.id);
    cut = true;
    await expect(sessions.prompt(fresh.id, "Now the route")).rejects.toThrow("cancelled");

    expect((await sessions.status(fresh.id)).state).toBe("starting");
    expect((await rejection(sessions.prompt(fresh.id, "Now the route"))).code).toBe("not_ready");

    clock.advance(6 * 60_000 + 1);

    expect(await sessions.status(fresh.id)).toMatchObject({
      state: "failed",
      error: "The workspace stopped while it was starting. Send a prompt to start it again.",
    });
    await sessions.prompt(fresh.id, "Now the route");
    // The launch's, and the one after the stall: the cut one never reached the sandbox.
    expect(checkouts()).toHaveLength(2);
    expect(turns().map((turn) => turn.command.at(-1))).toEqual(["Add an export", "Now the route"]);
    expect((await sessions.status(fresh.id)).state).toBe("idle");
  });
});

describe("stop", () => {
  it("stops the sandbox, and a prompt then resumes the session from its fork", async () => {
    const { sessions, sandboxes, streams, turns, checkouts, clock } = await setup();
    streams.push(says(clock.now() + 1_000, "Added the export."));
    await sessions.launch(fresh.id, "Add an export");
    const grants = sandboxes.startOptions(sandboxId)?.egress;

    await sessions.stop(fresh.id);

    expect(await sandboxes.get(sandboxId).isRunning()).toBe(false);
    expect(await sessions.status(fresh.id)).toMatchObject({ state: "asleep", error: null });
    // Nobody read the log while the sandbox was up: the stop recorded it.
    const before = await sessions.events(fresh.id, 0);
    expect(before.map(detail)).toEqual([
      "starting",
      "Add an export",
      "working",
      "Added the export.",
      "idle",
    ]);

    const resumed = clock.advance(3_600_000);
    streams.push(says(resumed + 1_000, "Added the route."));
    await sessions.prompt(fresh.id, "Now the route");

    expect(await sandboxes.get(sandboxId).isRunning()).toBe(true);
    expect(sandboxes.startOptions(sandboxId)).toEqual({
      ...workspace,
      instance: "standard-1",
      egress: grants,
    });
    expect(grants).toHaveLength(2);
    // The disk went with the sandbox: the fork is checked out again, and the
    // agent has no conversation there to continue.
    expect(checkouts()).toHaveLength(2);
    const turn = turns().at(-1);
    expect(turn?.name).toBe("turn-7");
    expect(turn?.command).not.toContain("--continue");
    expect(turn?.command.at(-1)).toBe("Now the route");
    // The log outlived the sandbox, and goes on counting.
    expect(await sessions.events(fresh.id, 0)).toEqual([
      ...before,
      ...[
        { seq: 6, at: resumed, type: "state", state: "starting" },
        { seq: 7, at: resumed, type: "prompt", text: "Now the route" },
        { seq: 8, at: resumed, type: "state", state: "working" },
        { seq: 9, at: resumed + 1_000, type: "assistant", text: "Added the route." },
        { seq: 10, at: resumed + 1_000, type: "state", state: "idle" },
      ].map((event) => ({ sessionId: fresh.id, ...event })),
    ]);
    expect((await sessions.status(fresh.id)).state).toBe("idle");
  });

  it("resumes on the branch of the session's change, and bills the change", async () => {
    const { sessions, sandboxes, checkouts, db } = await setup();
    const cloud = demo.sessions.find((session) => session.kind === "cloud");
    if (!cloud) throw new Error("the demo has no hosted session");
    const [change] = await db
      .select()
      .from(schema.changes)
      .where(eq(schema.changes.sessionId, cloud.id));

    await sessions.prompt(cloud.id, "Add the route too");

    expect(checkouts()[0]?.command[6]).toBe(change?.headRef.replace("refs/heads/", ""));
    const [fork, models] = sandboxes.startOptions(`sbx_${cloud.id.slice(4)}`)?.egress ?? [];
    expect(fork).toEqual({ kind: "git", repo: cloud.forkRepo, scope: "write" });
    expect(models).toMatchObject({ kind: "models", attribution: { changeId: change?.id } });
  });

  it("can be called for a session that is already stopped", async () => {
    const { sessions } = await setup();
    await sessions.stop(fresh.id);
    await sessions.launch(fresh.id, "Add an export");
    await sessions.stop(fresh.id);
    await sessions.stop(fresh.id);
    expect((await sessions.status(fresh.id)).state).toBe("asleep");
  });

  // The real controller refuses every read once its container is gone
  // (`SandboxController.requireRunning`); the fake answers them.
  it("reads a sandbox that stopped under it as asleep", async () => {
    let lost = false;
    const unavailable = async (): Promise<never> => {
      throw new ForgeError("unavailable", "The sandbox is not running.");
    };
    const { sessions, sandboxes } = await setup({
      sandboxes: (host) =>
        overriding(host, (sandbox) => ({
          // The container is found gone only when it is next asked for something.
          isRunning: async () => {
            const running = await sandbox.isRunning();
            if (lost && running) {
              await sandbox.stop();
              return true;
            }
            return running;
          },
          readFile: (path) => (lost ? unavailable() : sandbox.readFile(path)),
          processStatus: (name) => (lost ? unavailable() : sandbox.processStatus(name)),
          readLog: (name, stream, offset) =>
            lost ? unavailable() : sandbox.readLog(name, stream, offset),
        })),
    });
    await sessions.launch(fresh.id, "Add an export");

    const recorded = await sessions.events(fresh.id, 0);

    lost = true;
    expect((await sessions.status(fresh.id)).state).toBe("asleep");
    // What was recorded is still there; nothing is read from the sandbox.
    expect(await sessions.events(fresh.id, 0)).toEqual(recorded);
    await sandboxes.get(sandboxId).start({ ...workspace, instance: "standard-1", egress: [] });
    expect(await sessions.events(fresh.id, 0)).toEqual(recorded);
    expect((await sessions.status(fresh.id)).state).toBe("asleep");
  });

  it("does not hide a failure of a sandbox that is still running", async () => {
    const { sessions } = await setup({
      sandboxes: (host) =>
        overriding(host, () => ({
          readFile: async () => {
            throw new ForgeError("unavailable", "The sandbox was lost: connection reset");
          },
        })),
    });
    await sessions.launch(fresh.id, "Add an export").catch(() => {});

    expect((await rejection(sessions.status(fresh.id))).code).toBe("unavailable");
  });
});
