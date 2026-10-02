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
import { numberEvents, readTurnStream, type SessionEventDraft } from "./events";
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
/** A turn that runs longer than this is killed, so a stuck agent cannot hold a container for hours. */
const TURN_TIMEOUT_SECONDS = 60 * 60;
/** How much of git's output a failed checkout quotes. */
const TAIL_CHARACTERS = 1_000;

/**
 * What the forge knows about a session's workspace. It is a file in the
 * sandbox, beside the checkout it describes, and is gone when the sandbox is.
 * Code in the sandbox can rewrite it, so it is validated when read and never
 * decides anything but what the session's owner is shown.
 */
const SessionState = z.object({
  startedAt: z.number(),
  branch: z.string().min(1),
  /** The fork is checked out and a prompt can run. */
  ready: z.boolean(),
  /** Why the checkout failed. */
  error: z.string().nullable(),
  turns: z.array(z.object({ at: z.number(), prompt: z.string() })),
});
type SessionState = z.infer<typeof SessionState>;
type Turn = SessionState["turns"][number];

interface SessionContext {
  session: Session;
  owner: { name: string; email: string };
  settings: OrganisationSettings;
  /** The fork's HTTPS remote. No credential is in it: the egress adds one. */
  remote: string;
  branch: string;
  changeId: ChangeId | null;
}

function sandboxIdFor(sessionId: SessionId): SandboxId {
  return makeId("sandbox", sessionId.slice(idPrefixes.session.length + 1));
}

/** The branch a session's work goes to until it has a change, whose branch it then is. */
function branchName(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 50)
    .replace(/^-+|-+$/g, "");
  return slug || "session";
}

function processName(turnIndex: number): string {
  return `turn-${turnIndex + 1}`;
}

function exitMessage(exitCode: number): string {
  if (exitCode === 124 || exitCode === 137) {
    return "The agent was stopped: it ran out of time or memory.";
  }
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

/** One turn as events: the prompt, what the agent did, and how it ended if it has. */
async function readTurn(
  sandbox: Sandbox,
  turn: Turn,
  index: number,
): Promise<{ running: boolean; drafts: SessionEventDraft[] }> {
  const name = processName(index);
  // Asked before the stream is read: a process seen to have exited has
  // nothing more to write, so what follows its stream stays where it is.
  const status = await sandbox.processStatus(name);
  const stream = await readStream(sandbox, name);
  // A turn recorded but not yet spawned is on its way; `runTurn` withdraws one that never starts.
  const running = status?.state !== "exited";

  const drafts: SessionEventDraft[] = [
    { at: turn.at, type: "prompt", text: turn.prompt },
    { at: turn.at, type: "state", state: "working" },
  ];
  // The last line of a running turn may be half written.
  const said = readTurnStream(running ? stream.slice(0, stream.lastIndexOf("\n") + 1) : stream);
  drafts.push(...said);
  if (status?.state !== "exited") return { running, drafts };

  const end = said.at(-1)?.at ?? turn.at;
  if (status.exitCode !== 0 && !said.some((event) => event.type === "error")) {
    drafts.push({ at: end, type: "error", message: exitMessage(status.exitCode) });
  }
  drafts.push({ at: end, type: "state", state: "idle" });
  return { running, drafts };
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
 * after it. Its state and its event log live in that sandbox: the state in a
 * file, the log as the output of one background process per prompt. Nothing
 * is kept in the database, so a stopped session has no log to show, and a
 * session resumed after a stop is rebuilt from the fork: a new checkout of
 * what was pushed, and an agent that starts a new conversation.
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
      branch: change ? change.headRef.replace(/^refs\/heads\//, "") : branchName(session.title),
      changeId: change?.id ?? null,
    };
  }

  /** Clones the fork into a running sandbox. Safe to repeat: it starts from an empty directory. */
  async function checkout(sandbox: Sandbox, ctx: SessionContext): Promise<SessionState> {
    const state: SessionState = {
      startedAt: clock.now(),
      branch: ctx.branch,
      ready: false,
      error: null,
      turns: [],
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

  async function runTurn(
    sandbox: Sandbox,
    ctx: SessionContext,
    state: SessionState,
    prompt: string,
  ): Promise<void> {
    // The agent's own conversation is on the same disk as this state, so
    // there is one to continue exactly when this state has a turn.
    const agent = command(ctx, prompt, state.turns.length > 0);
    const turns = [...state.turns, { at: clock.now(), prompt }];
    await writeState(sandbox, { ...state, turns });
    try {
      await sandbox.spawn(
        processName(turns.length - 1),
        ["bash", "-c", TURN_SCRIPT, "gitflare-turn", state.branch, ...agent.command],
        { cwd: WORKSPACE, env: agent.env, timeoutSeconds: TURN_TIMEOUT_SECONDS },
      );
    } catch (error) {
      // A turn that never started must not read as one still running.
      await writeState(sandbox, state).catch(() => {});
      throw error;
    }
  }

  return {
    /** Safe to call twice: a session that already has its first turn is left alone. */
    async launch(sessionId, prompt) {
      const ctx = await context(sessionId);
      command(ctx, prompt, false);
      const sandbox = sandboxes.get(sandboxIdFor(sessionId));

      let state: SessionState | null = null;
      if (await sandbox.isRunning()) {
        state = await readState(sandbox);
        if (state?.ready && state.turns.length > 0) return;
        if (state?.error) {
          await sandbox.stop();
          state = null;
        } else if (!state?.ready) {
          // An earlier launch was cut off between starting the sandbox and finishing the checkout.
          state = await checkout(sandbox, ctx);
        }
      }
      state ??= await boot(sandbox, ctx);
      await runTurn(sandbox, ctx, state, prompt);
    },

    async prompt(sessionId, text) {
      const ctx = await context(sessionId);
      command(ctx, text, false);
      const sandbox = sandboxes.get(sandboxIdFor(sessionId));

      let state: SessionState | null = null;
      if (await sandbox.isRunning()) {
        state = await readState(sandbox);
        if (state?.error) {
          await sandbox.stop();
          state = null;
        } else if (!state?.ready) {
          throw new ForgeError("not_ready", "The session's workspace is still starting.");
        } else if (state.turns.length > 0) {
          const last = await sandbox.processStatus(processName(state.turns.length - 1));
          if (last?.state !== "exited") {
            throw new ForgeError("conflict", "The agent is still working on the last prompt.");
          }
        }
      }
      // Asleep, or failed: the workspace is rebuilt from the fork.
      state ??= await boot(sandbox, ctx);
      await runTurn(sandbox, ctx, state, text);
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
          if (!state.ready) return report("starting", state.startedAt);
          const last = state.turns.at(-1);
          if (!last) return report("idle", state.startedAt);
          const turn = await readTurn(sandbox, last, state.turns.length - 1);
          return report(turn.running ? "working" : "idle", turn.drafts.at(-1)?.at ?? last.at);
        },
        report("asleep", clock.now()),
      );
    },

    async events(sessionId, after) {
      const sandbox = sandboxes.get(sandboxIdFor(sessionId));
      return whileRunning(sandbox, async () => {
        const state = await readState(sandbox);
        if (!state) return [];
        const drafts: SessionEventDraft[] = [
          { at: state.startedAt, type: "state", state: "starting" },
        ];
        if (state.error) {
          drafts.push(
            { at: state.startedAt, type: "error", message: state.error },
            { at: state.startedAt, type: "state", state: "failed" },
          );
        }
        for (const [index, turn] of state.turns.entries()) {
          drafts.push(...(await readTurn(sandbox, turn, index)).drafts);
        }
        return numberEvents(sessionId, drafts, after);
      }, []);
    },

    async stop(sessionId) {
      await sandboxes.get(sandboxIdFor(sessionId)).stop();
    },
  };
}
