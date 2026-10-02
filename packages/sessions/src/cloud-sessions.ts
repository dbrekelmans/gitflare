import {
  type ChangeId,
  type CloudSessionStatus,
  ForgeError,
  idPrefixes,
  makeId,
  type OrganisationSettings,
  type SandboxId,
  type Session,
  type SessionId,
} from "@gitflare/core";
import {
  type Clock,
  type CloudSessions,
  type GitHost,
  type Sandbox,
  type SandboxHost,
  workspaceStart,
} from "@gitflare/core/ports";
import { type Db, schema } from "@gitflare/db";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { agentCommand } from "./agent";
import { readTurnStream, type SessionEventDraft } from "./events";
import {
  agentActedAfter,
  appendEvents,
  eventsAfter,
  findPrompt,
  lastEvent,
  type PromptEvent,
  storeEvents,
} from "./log";
import { CHECKOUT_SCRIPT, TURN_SCRIPT } from "./scripts";

export interface SessionsDeps {
  db: Db;
  git: GitHost;
  sandboxes: SandboxHost;
  clock: Clock;
  /**
   * The deployment's AI gateway as the agent addresses it:
   * `https://gateway.ai.cloudflare.com/v1/<account>/<gateway>/anthropic`. The
   * sandbox's model grant covers this URL and nothing else.
   */
  gatewayBaseUrl: string;
}

/** Where the fork is checked out. `containers/workspace/setup.sh` creates it. */
const WORKSPACE = "/workspace";
// Outside the checkout, so the agent's `git status` never sees it, and outside
// the controller's process directory, which a start clears.
const STATE_PATH = "/var/lib/gitflare/session.json";
const INSTANCE = "standard-1";
const CHECKOUT_TIMEOUT_SECONDS = 300;
/** A checkout not finished this long after it began was cut off, and is started over. */
const CHECKOUT_STALLED_MS = (CHECKOUT_TIMEOUT_SECONDS + 60) * 1_000;
/** The agent is stopped after this long, so a stuck agent cannot hold a container for hours. */
const AGENT_TIMEOUT_SECONDS = 60 * 60;
/**
 * The whole turn is killed after this long: the agent's limit, the grace it
 * is given to exit, and time to push what it committed.
 */
const TURN_TIMEOUT_SECONDS = AGENT_TIMEOUT_SECONDS + 30 + 120;
/** A prompt whose agent has not started this long after it was recorded never will. */
const SPAWN_GRACE_MS = 5 * 60_000;
/** How much of git's output a failed checkout quotes. */
const TAIL_CHARACTERS = 1_000;

/**
 * What the forge knows about the workspace in a sandbox. It is a file in the
 * sandbox, beside the checkout it describes, and is gone when the sandbox is.
 * Code in the sandbox can rewrite it, so it is validated when read and never
 * decides anything but what the session's owner is shown. What the session
 * did is in its event log, which outlives the sandbox.
 */
const SessionState = z.object({
  startedAt: z.number(),
  /** The number of this workspace's `starting` event: its turns are the prompts after it. */
  since: z.number().int().nonnegative(),
  branch: z.string().min(1),
  /** The fork is checked out and a prompt can run. */
  ready: z.boolean(),
  /** Why the checkout failed. */
  error: z.string().nullable(),
});
type SessionState = z.infer<typeof SessionState>;

interface SessionContext {
  session: Session;
  owner: { name: string; email: string };
  settings: OrganisationSettings;
  /** The fork's HTTPS remote. No credential is in it: the egress adds one. */
  remote: string;
  branch: string;
  changeId: ChangeId | null;
}

/** What a workspace's latest turn has come to. */
interface TurnReading {
  working: boolean;
  updatedAt: number;
}

function sandboxIdFor(sessionId: SessionId): SandboxId {
  return makeId("sandbox", sessionId.slice(idPrefixes.session.length + 1));
}

/**
 * The branch a session's work goes to until it has a change, whose branch it
 * then is. The fork is a full copy of the repository, so the session's own id
 * is in the name: a title alone could name `main`.
 */
function branchName(title: string, sessionId: SessionId): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 50)
    .replace(/^-+|-+$/g, "");
  const id = sessionId.slice(idPrefixes.session.length + 1).toLowerCase();
  return `${slug || "session"}-${id}`;
}

/** A turn's process is named after its prompt's place in the log. */
function processName(promptSeq: number): string {
  return `turn-${promptSeq}`;
}

function exitMessage(exitCode: number): string {
  if (exitCode === 124) return "The agent was stopped: it ran out of time.";
  if (exitCode === 137) return "The agent was stopped: it ran out of time or memory.";
  return `The agent stopped unexpectedly (exit code ${exitCode}).`;
}

async function readState(sandbox: Sandbox): Promise<SessionState | null> {
  const text = await sandbox.readFile(STATE_PATH);
  if (text === null) return null;
  try {
    const state = SessionState.safeParse(JSON.parse(text));
    return state.success ? state.data : null;
  } catch {
    return null;
  }
}

async function writeState(sandbox: Sandbox, state: SessionState): Promise<void> {
  await sandbox.writeFile(STATE_PATH, JSON.stringify(state));
}

async function readStream(sandbox: Sandbox, name: string): Promise<string> {
  let stream = "";
  let offset = 0;
  for (;;) {
    const chunk = await sandbox.readLog(name, "stdout", offset);
    if (chunk.nextOffset === offset) return stream;
    stream += chunk.text;
    offset = chunk.nextOffset;
  }
}

/**
 * Reads from a sandbox that may not be running. A stopped sandbox answers
 * nothing: its controller throws `unavailable` for every read, and it can
 * stop between two of them.
 */
async function whileRunning<T>(sandbox: Sandbox, read: () => Promise<T>, stopped: T): Promise<T> {
  if (!(await sandbox.isRunning())) return stopped;
  try {
    return await read();
  } catch (error) {
    const lost = error instanceof ForgeError && error.code === "unavailable";
    if (lost && !(await sandbox.isRunning())) return stopped;
    throw error;
  }
}

/**
 * The `CloudSessions` port over sandboxes. A session has one sandbox, named
 * after it, holding its workspace: a checkout of the fork, a state file, and
 * one background process per prompt whose output is the agent's events. What
 * happened is copied from there into `cloud_session_events` as it is read,
 * and prompts are recorded there before their agent starts, so the log
 * outlives the sandbox. A session resumed after a stop is rebuilt from the
 * fork: a new checkout of what was pushed, and an agent that starts a new
 * conversation; its events go on from the last number.
 */
export function createCloudSessions(deps: SessionsDeps): CloudSessions {
  const { db, git, sandboxes, clock } = deps;

  /** Everything a workspace is built from. Throws when the session cannot have one. */
  async function context(sessionId: SessionId): Promise<SessionContext> {
    const [session] = await db
      .select()
      .from(schema.sessions)
      .where(eq(schema.sessions.id, sessionId))
      .limit(1);
    if (!session) throw new ForgeError("not_found", "Session not found");
    if (session.kind !== "cloud") {
      throw new ForgeError("invalid", "Only a cloud session has a hosted agent.");
    }
    if (session.status !== "active") throw new ForgeError("conflict", "The session has ended.");
    if (!session.forkReadyAt || session.forkDeletedAt) {
      throw new ForgeError("not_ready", "The session's fork is not ready.");
    }
    const fork = await git.getRepo(session.forkRepo);
    if (!fork) {
      throw new ForgeError("not_found", `The session's fork ${session.forkRepo} does not exist.`);
    }
    if (fork.status !== "ready") {
      throw new ForgeError("not_ready", "The session's fork is still being copied.");
    }

    const [[owner], [repository], [change]] = await Promise.all([
      db.select().from(schema.users).where(eq(schema.users.id, session.userId)).limit(1),
      db
        .select({ organisationId: schema.repositories.organisationId })
        .from(schema.repositories)
        .where(eq(schema.repositories.id, session.repositoryId))
        .limit(1),
      db
        .select({ id: schema.changes.id, headRef: schema.changes.headRef })
        .from(schema.changes)
        .where(eq(schema.changes.sessionId, session.id))
        .limit(1),
    ]);
    if (!owner) throw new ForgeError("not_found", "The session's owner was not found.");
    if (!repository) throw new ForgeError("not_found", "Repository not found");
    const [organisation] = await db
      .select({ settings: schema.organisations.settings })
      .from(schema.organisations)
      .where(eq(schema.organisations.id, repository.organisationId))
      .limit(1);
    if (!organisation) throw new ForgeError("not_found", "Organisation not found");

    return {
      session,
      owner: { name: owner.name, email: owner.email },
      settings: organisation.settings,
      remote: fork.remote,
      branch: change
        ? change.headRef.replace(/^refs\/heads\//, "")
        : branchName(session.title, session.id),
      changeId: change?.id ?? null,
    };
  }

  function stalled(state: SessionState): boolean {
    return !state.ready && !state.error && clock.now() - state.startedAt > CHECKOUT_STALLED_MS;
  }

  /** Clones the fork into a running sandbox. Safe to repeat: it starts from an empty directory. */
  async function checkout(sandbox: Sandbox, ctx: SessionContext): Promise<SessionState> {
    const sessionId = ctx.session.id;
    const startedAt = clock.now();
    const [starting] = await appendEvents(db, sessionId, [
      { at: startedAt, type: "state", state: "starting" },
    ]);
    if (!starting) throw new Error(`the start of session ${sessionId} was not recorded`);
    const state: SessionState = {
      startedAt,
      since: starting.seq,
      branch: ctx.branch,
      ready: false,
      error: null,
    };
    await writeState(sandbox, state);
    const result = await sandbox.exec(
      [
        "sh",
        "-c",
        CHECKOUT_SCRIPT,
        "gitflare-checkout",
        ctx.remote,
        WORKSPACE,
        ctx.branch,
        ctx.owner.name,
        ctx.owner.email,
      ],
      { cwd: "/", timeoutSeconds: CHECKOUT_TIMEOUT_SECONDS },
    );
    if (result.exitCode !== 0) {
      const detail = result.stderr.trim().slice(-TAIL_CHARACTERS) || `exit code ${result.exitCode}`;
      const error = `The session's fork could not be checked out: ${detail}`;
      // The sandbox is left up to say why; a later prompt starts over.
      await writeState(sandbox, { ...state, error });
      const at = clock.now();
      await appendEvents(db, sessionId, [
        { at, type: "error", message: error },
        { at, type: "state", state: "failed" },
      ]);
      throw new ForgeError("unavailable", error);
    }
    const ready = { ...state, ready: true };
    await writeState(sandbox, ready);
    return ready;
  }

  async function boot(sandbox: Sandbox, ctx: SessionContext): Promise<SessionState> {
    const { session } = ctx;
    await sandbox.start({
      ...workspaceStart(ctx.settings.workspace),
      instance: INSTANCE,
      // All a session may reach: its own fork, and the model gateway. Never a
      // host grant: `*` would open the Internet with nothing intercepted.
      egress: [
        { kind: "git", repo: session.forkRepo, scope: "write" },
        {
          kind: "models",
          attribution: {
            agent: "session",
            userId: session.userId,
            repositoryId: session.repositoryId,
            sessionId: session.id,
            ...(ctx.changeId ? { changeId: ctx.changeId } : {}),
          },
        },
      ],
    });
    return checkout(sandbox, ctx);
  }

  function command(ctx: SessionContext, prompt: string, resume: boolean) {
    return agentCommand({
      prompt,
      model: ctx.settings.models.session,
      gatewayBaseUrl: deps.gatewayBaseUrl,
      resume,
    });
  }

  /** One turn as the events that follow its prompt, and whether it is still going. */
  async function readTurn(
    sandbox: Sandbox,
    prompt: PromptEvent,
  ): Promise<{ working: boolean; drafts: SessionEventDraft[] }> {
    const name = processName(prompt.seq);
    // Asked before the stream is read: a process seen to have exited has
    // nothing more to write, so what follows its stream stays where it is.
    const status = await sandbox.processStatus(name);
    if (!status) {
      // Recorded, and its agent not started: on its way, or cut off before it was.
      if (clock.now() - prompt.at < SPAWN_GRACE_MS) return { working: true, drafts: [] };
      return {
        working: false,
        drafts: [
          {
            at: prompt.at,
            type: "error",
            message: "The agent never started. Send the prompt again.",
          },
          { at: prompt.at, type: "state", state: "idle" },
        ],
      };
    }
    const stream = await readStream(sandbox, name);
    const running = status.state !== "exited";
    // The last line of a running turn may be half written.
    const said = readTurnStream(running ? stream.slice(0, stream.lastIndexOf("\n") + 1) : stream);
    if (status.state !== "exited") return { working: true, drafts: said };

    const end = said.at(-1)?.at ?? prompt.at;
    const drafts = [...said];
    if (status.exitCode !== 0 && !said.some((event) => event.type === "error")) {
      drafts.push({ at: end, type: "error", message: exitMessage(status.exitCode) });
    }
    drafts.push({ at: end, type: "state", state: "idle" });
    return { working: false, drafts };
  }

  /**
   * Records what the workspace's latest turn has done since it was last read.
   * Its events take the numbers after its prompt and the `working` that
   * follows it, which nothing else is given while it runs. Null when the
   * workspace has had no prompt.
   */
  async function recordTurn(
    sandbox: Sandbox,
    sessionId: SessionId,
    state: SessionState,
  ): Promise<TurnReading | null> {
    const prompt = await findPrompt(db, sessionId, { latestAfter: state.since });
    if (!prompt) return null;
    const last = await lastEvent(db, sessionId);
    // A turn whose end is recorded has nothing more to say: its log is not read again.
    if (last && last.seq > prompt.seq && last.type === "state" && last.state === "idle") {
      return { working: false, updatedAt: last.at };
    }
    const turn = await readTurn(sandbox, prompt);
    await storeEvents(db, sessionId, prompt.seq + 2, turn.drafts);
    return { working: turn.working, updatedAt: turn.drafts.at(-1)?.at ?? prompt.at };
  }

  /** Records what a running sandbox's latest turn has done; nothing for a stopped one. */
  async function recordLatest(sandbox: Sandbox, sessionId: SessionId): Promise<void> {
    await whileRunning(
      sandbox,
      async () => {
        const state = await readState(sandbox);
        if (state?.ready) await recordTurn(sandbox, sessionId, state);
      },
      undefined,
    );
  }

  /**
   * Starts the agent for a recorded prompt. With `endIfRefused`, a turn whose
   * agent surely did not start is ended with the reason: the prompt's sender
   * is told, and sends it again. Without, it waits for the caller's retry.
   */
  async function startTurn(
    sandbox: Sandbox,
    ctx: SessionContext,
    state: SessionState,
    prompt: PromptEvent,
    options: { resume: boolean; endIfRefused: boolean },
  ): Promise<void> {
    const agent = command(ctx, prompt.text, options.resume);
    const name = processName(prompt.seq);
    try {
      await sandbox.spawn(
        name,
        [
          "bash",
          "-c",
          TURN_SCRIPT,
          "gitflare-turn",
          state.branch,
          String(AGENT_TIMEOUT_SECONDS),
          ...agent.command,
        ],
        { cwd: WORKSPACE, env: agent.env, timeoutSeconds: TURN_TIMEOUT_SECONDS },
      );
    } catch (error) {
      // One that might have started is left to be read, or to run out its grace.
      const started = options.endIfRefused
        ? await sandbox.processStatus(name).catch(() => undefined)
        : undefined;
      if (started === null) {
        const at = clock.now();
        const message = `The agent could not be started: ${error instanceof Error ? error.message : String(error)}`;
        await storeEvents(db, ctx.session.id, prompt.seq + 2, [
          { at, type: "error", message },
          { at, type: "state", state: "idle" },
        ]).catch(() => {});
      }
      throw error;
    }
  }

  /** Records a prompt, then starts the agent on it. The workspace's earlier turns are all recorded. */
  async function runTurn(
    sandbox: Sandbox,
    ctx: SessionContext,
    state: SessionState,
    text: string,
    endIfRefused: boolean,
  ): Promise<void> {
    const sessionId = ctx.session.id;
    // The agent's own conversation is on the same disk as this workspace, so
    // there is one to continue once the agent has done something here.
    const resume = await agentActedAfter(db, sessionId, state.since);
    const at = clock.now();
    const [prompt] = await appendEvents(db, sessionId, [
      { at, type: "prompt", text },
      { at, type: "state", state: "working" },
    ]);
    if (prompt?.type !== "prompt") throw new Error(`the prompt of ${sessionId} was not recorded`);
    await startTurn(sandbox, ctx, state, prompt, { resume, endIfRefused });
  }

  return {
    /**
     * Safe to call twice, and after a stop: a session whose first prompt is
     * recorded is not sent it again. A call cut off between recording the
     * prompt and starting the agent is finished by the next one.
     */
    async launch(sessionId, prompt) {
      const ctx = await context(sessionId);
      command(ctx, prompt, false);
      const sandbox = sandboxes.get(sandboxIdFor(sessionId));

      const launched = await findPrompt(db, sessionId, { first: true });
      if (launched) {
        if (!(await sandbox.isRunning())) return;
        const state = await readState(sandbox);
        const last = await lastEvent(db, sessionId);
        const unstarted =
          state?.ready &&
          launched.seq > state.since &&
          last?.seq === launched.seq + 1 &&
          (await sandbox.processStatus(processName(launched.seq))) === null;
        if (state && unstarted) {
          await startTurn(sandbox, ctx, state, launched, { resume: false, endIfRefused: false });
        }
        return;
      }

      let state: SessionState | null = null;
      if (await sandbox.isRunning()) {
        state = await readState(sandbox);
        if (state?.error) {
          await sandbox.stop();
          state = null;
        } else if (!state?.ready) {
          // An earlier launch was cut off between starting the sandbox and finishing the checkout.
          state = await checkout(sandbox, ctx);
        }
      }
      state ??= await boot(sandbox, ctx);
      // Its caller retries a launch that failed: the prompt waits for that.
      await runTurn(sandbox, ctx, state, prompt, false);
    },

    async prompt(sessionId, text) {
      const ctx = await context(sessionId);
      command(ctx, text, false);
      // A launch that got as far as booting the workspace has a log.
      if (!(await lastEvent(db, sessionId))) {
        throw new ForgeError("not_ready", "The session has not been launched yet.");
      }
      const sandbox = sandboxes.get(sandboxIdFor(sessionId));

      let state: SessionState | null = null;
      if (await sandbox.isRunning()) {
        state = await readState(sandbox);
        if (!state || state.error || stalled(state)) {
          // A workspace that failed, or whose start was cut off: it is built again.
          await sandbox.stop();
          state = null;
        } else if (!state.ready) {
          throw new ForgeError("not_ready", "The session's workspace is still starting.");
        } else if ((await recordTurn(sandbox, sessionId, state))?.working) {
          throw new ForgeError("conflict", "The agent is still working on the last prompt.");
        }
      }
      // Asleep, or failed: the workspace is rebuilt from the fork.
      state ??= await boot(sandbox, ctx);
      await runTurn(sandbox, ctx, state, text, true);
    },

    async status(sessionId) {
      const sandbox = sandboxes.get(sandboxIdFor(sessionId));
      const report = (
        state: CloudSessionStatus["state"],
        updatedAt: number,
        error: string | null = null,
      ): CloudSessionStatus => ({ sessionId, state, error, updatedAt });

      return whileRunning(
        sandbox,
        async () => {
          const state = await readState(sandbox);
          if (!state) return report("starting", clock.now());
          if (state.error) return report("failed", state.startedAt, state.error);
          if (stalled(state)) {
            const error =
              "The workspace stopped while it was starting. Send a prompt to start it again.";
            return report("failed", state.startedAt, error);
          }
          if (!state.ready) return report("starting", state.startedAt);
          const turn = await recordTurn(sandbox, sessionId, state);
          if (!turn) return report("idle", state.startedAt);
          return report(turn.working ? "working" : "idle", turn.updatedAt);
        },
        report("asleep", clock.now()),
      );
    },

    async events(sessionId, after) {
      await recordLatest(sandboxes.get(sandboxIdFor(sessionId)), sessionId);
      return eventsAfter(db, sessionId, after);
    },

    async stop(sessionId) {
      const sandbox = sandboxes.get(sandboxIdFor(sessionId));
      // What the agent did since the log was last read goes with the sandbox.
      // Stopping matters more: a sandbox that cannot be read is stopped anyway.
      await recordLatest(sandbox, sessionId).catch(() => {});
      await sandbox.stop();
    },
  };
}
