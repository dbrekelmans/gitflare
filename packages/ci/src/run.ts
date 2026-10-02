import {
  CI_CONFIG_PATH,
  type CiConfig,
  type CiRun,
  type CiRunId,
  type CiStatus,
  type CiStep,
  type CiStepId,
  ForgeError,
  idPrefixes,
  makeId,
  type SandboxId,
  type StageInput,
  type StageOutcome,
} from "@gitflare/core";
import {
  type ChangeLive,
  type Clock,
  type EgressGrant,
  type GitHost,
  type IdGenerator,
  type ProcessStatus,
  type Sandbox,
  type SandboxHost,
  workspaceStart,
} from "@gitflare/core/ports";
import { appendChangeEvent, type Db, schema } from "@gitflare/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { parseCiConfig, planSteps } from "./config";

const { changes, ciRuns, ciSteps, organisations, repositories, revisions, sessions } = schema;

export interface CiDeps {
  db: Db;
  git: GitHost;
  sandboxes: SandboxHost;
  live: ChangeLive;
  clock: Clock;
  ids: IdGenerator;
}

export interface StartCiRunOptions {
  /** How often the setup command is asked about while it runs. */
  pollMs?: number;
  /** The setup command is killed after this long. Keep it under the calling Workflow step's own timeout. */
  setupTimeoutSeconds?: number;
}

export type CiStart =
  | { status: "started"; run: CiRun; waves: string[][] }
  /** The repository has no CI file at this commit: the stage is skipped. */
  | { status: "skipped"; reason: string };

/** Where the head is checked out; `setup.sh` leaves `/workspace` in the snapshot. */
export const CI_WORKDIR = "/workspace/repo";

/**
 * The hosts every CI sandbox may read from besides its repository: the
 * registry of the package managers the workspace ships (npm and pnpm). A
 * repository names any others in its CI file (`egress.hosts`). Each is named;
 * a host grant of `*` would open the whole Internet with nothing intercepted.
 */
export const CI_REGISTRY_HOSTS = ["registry.npmjs.org"];

/**
 * The sandbox could not be asked, but has not stopped: the call that threw
 * is safe to repeat and should be. Not a `ForgeError`, which the caller takes
 * as a refusal that a retry would only repeat.
 */
export class CiInterrupted extends Error {
  constructor(cause: unknown) {
    super(describe(cause), { cause });
    this.name = "CiInterrupted";
  }
}

/** A start that will fail the same way however often it is tried: the run's own failure. */
class CiRefusal extends ForgeError {}

/**
 * What a sandbox call threw, made safe to hand to the caller: the sandbox's
 * `unavailable` is infrastructure, not a verdict on the run, so it is retried.
 */
function interrupted(error: unknown): unknown {
  return error instanceof ForgeError ? new CiInterrupted(error) : error;
}

/**
 * Checks commit `$3` of remote `$2` out in a fresh directory `$1`. `$4` is
 * the branch it was pushed to: the fallback for a git host that will not
 * serve a commit by id. Shallow, because a full clone of a repository of tens
 * of megabytes takes a minute (spec/research/live/container-git.md).
 */
export const CHECKOUT_SCRIPT = `set -eu
dir=$1
rm -rf "$dir"
git init -q "$dir"
cd "$dir"
git remote add origin "$2"
git fetch -q --depth=1 origin "$3" || git fetch -q --depth=50 origin "$4"
git checkout -q --detach "$3"`;

/**
 * Runs the repository's own command, `$1`, stopping at its first failing
 * line, with both streams in one log so that output reads in the order it
 * was written.
 */
export const RUN_SCRIPT = `exec sh -ec "$1" 2>&1`;

const SETUP_PROCESS = "setup";
const CHECKOUT_TIMEOUT_SECONDS = 300;
/** Where the count of a step's forwarded output is kept: in the sandbox, whose lifetime is the log's. */
const STATE_DIR = "/var/lib/gitflare/ci";
/** How much of a step's output is kept with its record. */
const LOG_TAIL_CHARACTERS = 8_000;
/** How much output one poll forwards: eight of the sandbox's 256 KiB pieces. */
const CHUNKS_PER_POLL = 8;
/** The most `readStepLog` reads from a live sandbox: 4 MiB. */
const CHUNKS_PER_READ = 16;
/** D1 allows 100 bound parameters per statement; a step row binds seven. */
const STEPS_PER_INSERT = 12;
const STEP_ENV = { CI: "true" };

type RunRow = typeof ciRuns.$inferSelect;
type EventDeps = Pick<CiDeps, "db" | "live" | "clock">;

function toRun(row: RunRow): CiRun {
  const { stageRunId: _stageRunId, ...run } = row;
  return run;
}

/** One sandbox per run, named after it, so that every call finds the same one. */
function sandboxIdOf(runId: CiRunId): SandboxId {
  return makeId("sandbox", runId.slice(idPrefixes.ciRun.length + 1));
}

/** A step can be named `setup`; its process cannot be. */
function processOf(stepName: string): string {
  return `step-${stepName}`;
}

function shell(command: string): string[] {
  return ["sh", "-c", RUN_SCRIPT, "gitflare-ci", command];
}

function tail(text: string): string {
  const kept = text.slice(-LOG_TAIL_CHARACTERS);
  // Never start with the second half of a surrogate pair.
  const first = kept.charCodeAt(0);
  return first >= 0xdc00 && first <= 0xdfff ? kept.slice(1) : kept;
}

/** A line of gitflare's own at the end of a step's output. */
function withNote(log: string, note: string): string {
  const separator = log === "" || log.endsWith("\n") ? "" : "\n";
  return tail(`${log}${separator}[gitflare] ${note}\n`);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function settled(status: CiStatus): boolean {
  return status !== "queued" && status !== "running";
}

async function requireRun(db: Db, runId: CiRunId): Promise<RunRow> {
  const [run] = await db.select().from(ciRuns).where(eq(ciRuns.id, runId));
  if (!run) throw new ForgeError("not_found", `There is no CI run ${runId}.`);
  return run;
}

async function requireStep(db: Db, stepId: CiStepId): Promise<CiStep> {
  const [step] = await db.select().from(ciSteps).where(eq(ciSteps.id, stepId));
  if (!step) throw new ForgeError("not_found", `There is no CI step ${stepId}.`);
  return step;
}

function stepsOf(db: Db, runId: CiRunId): Promise<CiStep[]> {
  return db.select().from(ciSteps).where(eq(ciSteps.runId, runId)).orderBy(ciSteps.position);
}

interface Source {
  organisationId: (typeof repositories.$inferSelect)["organisationId"];
  forkRepo: string;
  headRef: string;
  headSha: string;
}

/** The commit a revision's CI runs on, and the fork it is read from. */
async function sourceOf(db: Db, input: Pick<StageInput, "changeId" | "revisionId">) {
  const [change] = await db.select().from(changes).where(eq(changes.id, input.changeId));
  if (!change) throw new ForgeError("not_found", `There is no change ${input.changeId}.`);
  const [revision] = await db.select().from(revisions).where(eq(revisions.id, input.revisionId));
  if (!revision || revision.changeId !== change.id) {
    throw new ForgeError("not_found", `There is no revision ${input.revisionId} of this change.`);
  }
  const [session] = await db.select().from(sessions).where(eq(sessions.id, change.sessionId));
  const [repository] = await db
    .select()
    .from(repositories)
    .where(eq(repositories.id, change.repositoryId));
  if (!session || !repository) {
    throw new ForgeError("not_found", "The change's session or repository no longer exists.");
  }
  const source: Source = {
    organisationId: repository.organisationId,
    forkRepo: session.forkRepo,
    headRef: change.headRef,
    headSha: revision.headSha,
  };
  return source;
}

/** The CI file as of the commit under test, or null when the repository has none. */
async function readConfig(git: GitHost, source: Source): Promise<CiConfig | null> {
  const bytes = await git.readFile(source.forkRepo, { ref: source.headSha, path: CI_CONFIG_PATH });
  return bytes ? parseCiConfig(new TextDecoder().decode(bytes)) : null;
}

function emitStep(deps: EventDeps, run: RunRow, step: CiStep) {
  const { id: stepId, name, status } = step;
  return appendChangeEvent(deps, run.changeId, { type: "ci.step", stepId, name, status });
}

/**
 * Moves a step on from the status it was read in, and announces it. When
 * another call already moved it, nothing is written or announced and the
 * step is returned as that call left it.
 */
async function moveStep(
  deps: EventDeps,
  run: RunRow,
  step: CiStep,
  to: Partial<CiStep> & { status: CiStatus },
): Promise<CiStep> {
  const [moved] = await deps.db
    .update(ciSteps)
    .set(to)
    .where(and(eq(ciSteps.id, step.id), eq(ciSteps.status, step.status)))
    .returning();
  if (!moved) return requireStep(deps.db, step.id);
  await emitStep(deps, run, moved);
  return moved;
}

/**
 * Closes a run: every step that has no result is cancelled, and the run takes
 * its steps' verdict. With a `reason`, the run failed before its steps could
 * say anything, and it is kept as the run's answer.
 */
async function settleRun(deps: EventDeps, run: RunRow, reason?: string): Promise<CiStep[]> {
  const { db, clock } = deps;
  const cancelled = await db
    .update(ciSteps)
    .set({ status: "cancelled", finishedAt: clock.now() })
    .where(and(eq(ciSteps.runId, run.id), inArray(ciSteps.status, ["queued", "running"])))
    .returning();
  for (const step of cancelled) await emitStep(deps, run, step);
  const steps = await stepsOf(db, run.id);
  const status =
    !reason && steps.every((step) => step.status === "succeeded") ? "succeeded" : "failed";
  await db
    .update(ciRuns)
    .set({ status, reason: reason ?? null, finishedAt: clock.now() })
    .where(and(eq(ciRuns.id, run.id), inArray(ciRuns.status, ["queued", "running"])));
  return steps;
}

/**
 * False only when the sandbox says it has stopped. A sandbox that cannot be
 * asked is not assumed to be gone: the caller's error is then retried.
 */
async function sandboxIsUp(sandbox: Sandbox): Promise<boolean> {
  return sandbox.isRunning().catch(() => true);
}

async function stopSandbox(deps: Pick<CiDeps, "sandboxes">, runId: CiRunId): Promise<void> {
  await deps.sandboxes
    .get(sandboxIdOf(runId))
    .stop()
    .catch((error: unknown) => {
      throw interrupted(error);
    });
}

async function createRun(deps: CiDeps, input: StageInput, config: CiConfig): Promise<RunRow> {
  const { db, ids } = deps;
  // The steps name their run by the attempt, not by the id minted here: when
  // two calls race, both sets of steps land on the one run that was kept.
  const runId = sql<CiRunId>`(select ${ciRuns.id} from ${ciRuns} where ${ciRuns.stageRunId} = ${input.stageRunId})`;
  const rows = config.steps.map((step, position) => ({
    id: ids.next("ciStep"),
    runId,
    position,
    name: step.name,
    command: step.run,
    status: "queued" as const,
  }));
  const statements: BatchItem<"sqlite">[] = [];
  for (let from = 0; from < rows.length; from += STEPS_PER_INSERT) {
    statements.push(
      db
        .insert(ciSteps)
        .values(rows.slice(from, from + STEPS_PER_INSERT))
        .onConflictDoNothing(),
    );
  }
  await db.batch([
    db
      .insert(ciRuns)
      .values({
        id: ids.next("ciRun"),
        changeId: input.changeId,
        revisionId: input.revisionId,
        stageRunId: input.stageRunId,
        status: "queued",
      })
      .onConflictDoNothing(),
    ...statements,
  ]);
  const [run] = await db.select().from(ciRuns).where(eq(ciRuns.stageRunId, input.stageRunId));
  if (!run) throw new Error(`the CI run of ${input.stageRunId} was not recorded`);
  return run;
}

/** Boots the run's sandbox, checks the head out and runs the setup command. Safe to run again after a crash. */
async function prepareSandbox(
  deps: CiDeps,
  run: RunRow,
  source: Source,
  config: CiConfig,
  boot: ReturnType<typeof workspaceStart>,
  options: StartCiRunOptions,
): Promise<void> {
  const { pollMs = 2_000, setupTimeoutSeconds = 900 } = options;
  const repo = await deps.git.getRepo(source.forkRepo);
  if (!repo) {
    throw new CiRefusal("not_found", `The fork ${source.forkRepo} no longer exists.`);
  }
  const sandbox = deps.sandboxes.get(sandboxIdOf(run.id));
  if (!(await sandbox.isRunning())) {
    const hosts = new Set([...CI_REGISTRY_HOSTS, ...config.egress.hosts]);
    const egress: EgressGrant[] = [
      { kind: "git", repo: source.forkRepo, scope: "read" },
      ...[...hosts].map((host): EgressGrant => ({ kind: "host", host })),
    ];
    await sandbox.start({ ...boot, instance: config.instance, egress });
  }

  // A setup command that was already started is waited for, not started
  // again over a second checkout.
  let setup: ProcessStatus | null = await sandbox.processStatus(SETUP_PROCESS);
  if (!setup) {
    const checkout = await sandbox.exec(
      [
        "sh",
        "-c",
        CHECKOUT_SCRIPT,
        "gitflare-checkout",
        CI_WORKDIR,
        repo.remote,
        source.headSha,
        source.headRef,
      ],
      { timeoutSeconds: CHECKOUT_TIMEOUT_SECONDS },
    );
    if (checkout.exitCode !== 0) {
      throw new CiRefusal(
        "unavailable",
        `CI could not check the commit out (exit code ${checkout.exitCode}): ${tail(checkout.stderr).trim()}`,
      );
    }
    if (!config.setup) return;
    await sandbox.spawn(SETUP_PROCESS, shell(config.setup), {
      cwd: CI_WORKDIR,
      env: STEP_ENV,
      timeoutSeconds: setupTimeoutSeconds,
    });
    setup = await sandbox.processStatus(SETUP_PROCESS);
  }
  while (setup?.state === "running") {
    await new Promise((resolve) => setTimeout(resolve, pollMs));
    setup = await sandbox.processStatus(SETUP_PROCESS);
  }
  if (setup?.exitCode !== 0) {
    const { text } = await sandbox.readLog(SETUP_PROCESS, "stdout", 0);
    const how = setup ? `exit code ${setup.exitCode}` : "the sandbox lost it";
    throw new CiRefusal(
      "unavailable",
      `The setup command failed (${how}): ${text.slice(-2_000).trim()}`,
    );
  }
}

/**
 * Reads the CI file, creates the run and its steps, starts the sandbox,
 * checks the head out and runs the setup command.
 *
 * Nothing is recorded for a change with no CI file, a CI file that does not
 * parse, or a workspace nobody has prepared: the first is skipped and the
 * others throw. A run whose checkout or setup fails is closed, with its steps
 * cancelled and the failure as its `reason`, before the failure is thrown;
 * calling again throws that reason again. A sandbox that could not be asked
 * throws `CiInterrupted`, and the run is left for the retry.
 */
export async function startCiRun(
  deps: CiDeps,
  input: StageInput,
  options: StartCiRunOptions = {},
): Promise<CiStart> {
  const { db, git, clock } = deps;
  const source = await sourceOf(db, input);
  const config = await readConfig(git, source);
  if (!config) {
    return { status: "skipped", reason: `The repository has no ${CI_CONFIG_PATH} at this commit.` };
  }
  const waves = planSteps(config);

  const [existing] = await db.select().from(ciRuns).where(eq(ciRuns.stageRunId, input.stageRunId));
  if (existing?.reason) {
    // Refused by an earlier call, whose stop may be what failed.
    await stopSandbox(deps, existing.id);
    throw new CiRefusal("unavailable", existing.reason);
  }
  if (existing && existing.status !== "queued") {
    return { status: "started", run: toRun(existing), waves };
  }
  const [organisation] = await db
    .select()
    .from(organisations)
    .where(eq(organisations.id, source.organisationId));
  if (!organisation) throw new ForgeError("not_found", "The repository has no organisation.");
  const boot = workspaceStart(organisation.settings.workspace);

  const run = existing ?? (await createRun(deps, input, config));
  try {
    await prepareSandbox(deps, run, source, config, boot, options);
  } catch (error) {
    // A refusal will not go away on a retry; anything else is tried again.
    if (!(error instanceof CiRefusal)) throw interrupted(error);
    await settleRun(deps, run, error.message);
    await stopSandbox(deps, run.id);
    throw error;
  }
  await db
    .update(ciRuns)
    .set({ status: "running", startedAt: clock.now() })
    .where(and(eq(ciRuns.id, run.id), eq(ciRuns.status, "queued")));
  return { status: "started", run: toRun(await requireRun(db, run.id)), waves };
}

/**
 * Starts one step's command in the run's sandbox. Returns at once; the
 * command runs in the background. A step whose needs did not succeed is
 * skipped instead, and one whose sandbox has stopped is failed: both are
 * results of the step, not errors of the run. A command that cannot be
 * launched exits with `EXIT_NOT_LAUNCHED`, which `pollCiStep` records.
 */
export async function startCiStep(deps: CiDeps, runId: CiRun["id"], name: string): Promise<CiStep> {
  const { db, git, clock } = deps;
  const run = await requireRun(db, runId);
  const steps = await stepsOf(db, runId);
  const step = steps.find((candidate) => candidate.name === name);
  if (!step) throw new ForgeError("not_found", `The CI run has no step ${name}.`);
  if (step.status !== "queued") return step;
  if (run.status !== "running") {
    throw new ForgeError("conflict", `The CI run is ${run.status}; ${name} cannot start.`);
  }

  const config = await readConfig(git, await sourceOf(db, run));
  const planned = config?.steps.find((candidate) => candidate.name === name);
  if (!planned) throw new ForgeError("not_found", `${CI_CONFIG_PATH} has no step ${name}.`);
  const needs = steps.filter((candidate) => planned.needs.includes(candidate.name));
  const pending = needs.find((need) => !settled(need.status));
  if (pending) {
    throw new ForgeError("conflict", `${name} needs ${pending.name}, which has not finished.`);
  }
  const unmet = needs.filter((need) => need.status !== "succeeded").map((need) => need.name);
  if (unmet.length > 0) {
    return moveStep(deps, run, step, {
      status: "skipped",
      finishedAt: clock.now(),
      logTail: withNote("", `Not run: ${unmet.join(", ")} did not succeed.`),
    });
  }

  const sandbox = deps.sandboxes.get(sandboxIdOf(run.id));
  const process = processOf(name);
  try {
    // A process that is already there was started by an earlier call.
    if (!(await sandbox.processStatus(process))) {
      await sandbox.spawn(process, shell(step.command), {
        cwd: CI_WORKDIR,
        env: STEP_ENV,
        timeoutSeconds: planned.timeoutMinutes * 60,
      });
    }
  } catch (error) {
    if (await sandboxIsUp(sandbox)) throw interrupted(error);
    return moveStep(deps, run, step, {
      status: "failed",
      finishedAt: clock.now(),
      logTail: withNote("", "The sandbox stopped before this step could start."),
    });
  }
  return moveStep(deps, run, step, { status: "running", startedAt: clock.now() });
}

/**
 * Forwards output written since the last call as `ci.log` signals, and, when
 * the command has exited, records the step's result. Returns the step; the
 * caller sleeps and calls again while it is `running`.
 */
export async function pollCiStep(deps: CiDeps, stepId: CiStepId): Promise<CiStep> {
  const { db, live, clock } = deps;
  const step = await requireStep(db, stepId);
  if (step.status !== "running") return step;
  const run = await requireRun(db, step.runId);
  const sandbox = deps.sandboxes.get(sandboxIdOf(run.id));
  const process = processOf(step.name);
  const offsetFile = `${STATE_DIR}/${step.name}.offset`;

  let status: ProcessStatus | null;
  let log = step.logTail;
  let drained = false;
  try {
    // Asked before the log is read: once it has exited, what is read is all of it.
    status = await sandbox.processStatus(process);
    if (status) {
      const start = Number(await sandbox.readFile(offsetFile)) || 0;
      let offset = start;
      for (let read = 0; read < CHUNKS_PER_POLL && !drained; read++) {
        const chunk = await sandbox.readLog(process, "stdout", offset);
        if (chunk.nextOffset === offset) {
          drained = true;
        } else {
          await live
            .signal(run.changeId, { type: "ci.log", stepId, text: chunk.text })
            .catch(() => {});
          log = tail(log + chunk.text);
          offset = chunk.nextOffset;
        }
      }
      if (offset !== start) {
        await db.update(ciSteps).set({ logTail: log }).where(eq(ciSteps.id, stepId));
        await sandbox.writeFile(offsetFile, String(offset));
      }
    }
  } catch (error) {
    // A sandbox refuses every question once it has stopped; that is an
    // answer. Any other error is retried by the caller.
    if (await sandboxIsUp(sandbox)) throw interrupted(error);
    status = null;
  }

  // A sandbox that does not know a step it started was replaced under it.
  // A killed command and a killed container both report 137: only a sandbox
  // that is still up makes a non-zero exit the step's own.
  const lost =
    !status ||
    (status.state === "exited" && status.exitCode !== 0 && !(await sandboxIsUp(sandbox)));
  if (lost) {
    return moveStep(deps, run, step, {
      status: "failed",
      finishedAt: clock.now(),
      logTail: withNote(log, "The sandbox stopped before this step finished."),
    });
  }
  // Still running, or exited with output left to forward: the next call goes on.
  if (status?.state !== "exited" || !drained) return { ...step, logTail: log };

  const { exitCode } = status;
  if (exitCode === 124) log = withNote(log, "Exit code 124: the step ran out of time.");
  if (exitCode === 137) {
    log = withNote(log, "Exit code 137: the step was killed (out of memory, or out of time).");
  }
  return moveStep(deps, run, step, {
    status: exitCode === 0 ? "succeeded" : "failed",
    exitCode,
    finishedAt: clock.now(),
    logTail: log,
  });
}

/**
 * Settles the run from its steps, stops the sandbox, and says how the stage
 * ended. Steps that have no result by now are cancelled.
 */
export async function finishCiRun(
  deps: CiDeps,
  runId: CiRun["id"],
): Promise<StageOutcome | { status: "failed"; reason: string }> {
  const run = await requireRun(deps.db, runId);
  const steps = await settleRun(deps, run);
  await stopSandbox(deps, run.id);

  if (run.reason) return { status: "failed", reason: run.reason };
  if (steps.every((step) => step.status === "succeeded")) return { status: "succeeded" };
  const failed = steps.filter((step) => step.status === "failed");
  const [first] = failed;
  if (!first) return { status: "failed", reason: "CI stopped before every step had run." };
  const others = failed.length > 1 ? `, and ${failed.length - 1} more failed` : "";
  const how =
    first.exitCode === null
      ? "did not finish: the sandbox stopped or could not run it"
      : `failed with exit code ${first.exitCode}`;
  return { status: "failed", reason: `Step ${first.name} ${how}${others}.` };
}

/**
 * Closes the run of a stage attempt that could not be started or finished
 * the ordinary way, with `reason` as its answer, and stops its sandbox. Does
 * nothing to a run that is already closed, or when there is no run.
 */
export async function closeCiRun(
  deps: Pick<CiDeps, "db" | "sandboxes" | "live" | "clock">,
  stageRunId: StageInput["stageRunId"],
  reason: string,
): Promise<void> {
  const [run] = await deps.db.select().from(ciRuns).where(eq(ciRuns.stageRunId, stageRunId));
  if (!run) return;
  await settleRun(deps, run, reason);
  await stopSandbox(deps, run.id);
}

/** A step's output: the whole log while its sandbox is alive, the stored tail afterwards. */
export async function readStepLog(
  deps: Pick<CiDeps, "db" | "sandboxes">,
  stepId: CiStepId,
): Promise<{ text: string; complete: boolean }> {
  const step = await requireStep(deps.db, stepId);
  // A tail shorter than its limit lost nothing.
  const stored = { text: step.logTail, complete: step.logTail.length < LOG_TAIL_CHARACTERS };
  // A step that was never started has only what gitflare wrote about it.
  if (step.startedAt === null) return stored;
  const sandbox = deps.sandboxes.get(sandboxIdOf(step.runId));
  try {
    let text = "";
    let offset = 0;
    for (let read = 0; read < CHUNKS_PER_READ; read++) {
      const chunk = await sandbox.readLog(processOf(step.name), "stdout", offset);
      if (chunk.nextOffset === offset) return { text, complete: true };
      text += chunk.text;
      offset = chunk.nextOffset;
    }
    // Longer than is worth carrying through a Worker: the end is what a reader wants.
    return { ...stored, complete: false };
  } catch {
    // A stopped sandbox refuses to be read.
    return stored;
  }
}
