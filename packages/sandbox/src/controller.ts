import { ForgeError } from "@gitflare/core";
import type {
  EgressGrant,
  ExecOptions,
  ExecResult,
  LogChunk,
  ProcessStatus,
  SandboxSnapshot,
  SandboxStartOptions,
} from "@gitflare/core/ports";
import type { ContainerLike } from "./container";
import { type EgressMode, egressMode } from "./egress";
import {
  EXEC_SCRIPT,
  NO_SUCH_FILE,
  READ_FILE_SCRIPT,
  READ_LOG_SCRIPT,
  SPAWN_SCRIPT,
  STATUS_SCRIPT,
  WRITE_FILE_SCRIPT,
} from "./scripts";

/** What the controller persists between requests: the Durable Object's storage, narrowed. */
export interface ControllerStorage {
  get<T>(key: string): T | undefined;
  put<T>(key: string, value: T): void;
  delete(key: string): void;
}

export interface SandboxControllerOptions {
  container: ContainerLike;
  storage: ControllerStorage;
  /**
   * Registers the Worker-side handler for the container's outbound traffic.
   * Called on every start with intercepted egress: intercepts do not survive
   * a container stop.
   */
  applyEgress(grants: EgressGrant[]): Promise<void>;
  /** Asks the Durable Object to wake the controller again, to keep the container alive. */
  scheduleKeepAlive(delayMs: number): Promise<void>;
  /** How long the container outlives the Durable Object's last activity. Default ten minutes. */
  inactivityTimeoutMs?: number;
  /** How often the keep-alive alarm fires while a background process runs. Default one minute. */
  keepAliveIntervalMs?: number;
  /** The longest the alarm keeps a container alive for a process nobody asks about. Default six hours. */
  maxKeepAliveMs?: number;
  /** Where background processes keep their files in the container. */
  processRoot?: string;
}

interface ProcessRecord {
  dir: string;
  /** Set once the process was seen to have exited, so it is not asked about again. */
  exitCode?: number;
}

/** Everything the controller remembers about its container. Gone when the container is. */
interface ControllerState {
  image: string;
  egress: EgressMode;
  processes: Record<string, ProcessRecord>;
  nextProcess: number;
  /** Alarms left before the keep-alive gives up. Reset by every `spawn`. */
  keepAliveTicks: number;
}

const STATE_KEY = "sandbox";

// The managed image's default command exits at once; this keeps the container up.
const ENTRYPOINT = ["sleep", "infinity"];

const CA = "/etc/cloudflare/certs/cloudflare-containers-ca.crt";
// The container CA alone replaces the system trust store. That is only safe
// when every HTTPS request is intercepted: with some hosts intercepted and
// others not, tools hang without output (container-git.md, section 5).
const TRUST_ENV = {
  GIT_SSL_CAINFO: CA,
  NODE_EXTRA_CA_CERTS: CA,
  SSL_CERT_FILE: CA,
  CURL_CA_BUNDLE: CA,
};

/** What a process whose launcher vanished is reported as: the code of a killed process. */
const KILLED = 137;

const LOG_CHUNK_BYTES = 256 * 1024;
// One argument is limited to 128 KiB, and a UTF-16 unit is at most three bytes of UTF-8.
const WRITE_CHUNK_UNITS = 30_000;

const decoder = new TextDecoder();

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The length of the longest prefix of `bytes` that does not end inside a UTF-8 sequence. */
function completeUtf8Length(bytes: Uint8Array): number {
  for (let back = 1; back <= Math.min(4, bytes.length); back += 1) {
    const byte = bytes[bytes.length - back] ?? 0;
    if (byte < 0x80) break;
    if (byte >= 0xc0) {
      const length = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : 2;
      return length > back ? bytes.length - back : bytes.length;
    }
  }
  return bytes.length;
}

function chunks(text: string): string[] {
  const parts: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + WRITE_CHUNK_UNITS, text.length);
    // Never between the two halves of a surrogate pair.
    const last = text.charCodeAt(end - 1);
    if (end < text.length && last >= 0xd800 && last <= 0xdbff) end += 1;
    parts.push(text.slice(start, end));
    start = end;
  }
  return parts;
}

/**
 * The `Sandbox` port's behaviour for one container. The Durable Object
 * forwards each RPC method here, calls `onWake` from its constructor and
 * `onAlarm` from its alarm handler.
 *
 * Three facts from the live test shape it. Nothing inside a container keeps
 * it alive: only the Durable Object's own activity does, so while a
 * background process runs an alarm provides that activity. A process's pipe
 * dies with the request that started it, so background processes write to
 * files and are asked about through files. And `start()` returns before the
 * container exists, so a start is not reported as done until a command ran.
 */
export class SandboxController {
  private readonly container: ContainerLike;
  private readonly storage: ControllerStorage;
  private readonly inactivityTimeoutMs: number;
  private readonly keepAliveIntervalMs: number;
  private readonly keepAliveTicks: number;
  private readonly processRoot: string;

  constructor(private readonly options: SandboxControllerOptions) {
    this.container = options.container;
    this.storage = options.storage;
    this.inactivityTimeoutMs = options.inactivityTimeoutMs ?? 10 * 60_000;
    this.keepAliveIntervalMs = options.keepAliveIntervalMs ?? 60_000;
    this.keepAliveTicks = Math.ceil(
      (options.maxKeepAliveMs ?? 6 * 60 * 60_000) / this.keepAliveIntervalMs,
    );
    this.processRoot = options.processRoot ?? "/var/lib/gitflare/processes";
  }

  /**
   * Boots the container and returns once it has run a command. Throws
   * `conflict` when it is already running and `unavailable` when it does not
   * come up; a caller that retries should use another sandbox id, because one
   * Durable Object can fail to start for minutes while others start normally.
   */
  async start(options: SandboxStartOptions): Promise<void> {
    if (this.container.running) {
      throw new ForgeError("conflict", "The sandbox is already running.");
    }
    const egress = egressMode(options.egress);
    if (egress === "intercepted") await this.options.applyEgress(options.egress);

    const boot = {
      enableInternet: egress === "open",
      entrypoint: ENTRYPOINT,
      instance: options.instance,
    };
    try {
      if (options.snapshot) {
        this.container.start({ ...boot, containerSnapshot: { id: options.snapshot.id } });
      } else {
        const image = this.container.images?.[options.image] ?? options.image;
        this.container.start({ ...boot, image });
      }
      // `exec` waits for a container that is still starting, so the first one
      // is the readiness check. A snapshot carries the process files of the
      // container it was taken from; clearing them is that first command.
      const probe = await this.container.exec(["rm", "-rf", this.processRoot]);
      const { exitCode, stderr } = await probe.output();
      if (exitCode !== 0) throw new Error(decoder.decode(stderr).trim() || `exit ${exitCode}`);
      await this.container.setInactivityTimeout(this.inactivityTimeoutMs);
    } catch (error) {
      await this.container.destroy().catch(() => {});
      throw new ForgeError("unavailable", `The sandbox could not start: ${describe(error)}`);
    }
    this.save({ image: options.image, egress, processes: {}, nextProcess: 1, keepAliveTicks: 0 });
  }

  async isRunning(): Promise<boolean> {
    return this.container.running;
  }

  async exec(command: string[], options: ExecOptions = {}): Promise<ExecResult> {
    const state = this.requireRunning();
    const limit = timeLimit(options.timeoutSeconds);
    const argv = limit ? ["sh", "-c", EXEC_SCRIPT, "gitflare-exec", limit, ...command] : command;
    const result = await this.run(argv, { cwd: options.cwd, env: this.env(state, options) });
    // A killed command and a killed container both report 137: tell them apart
    // before anyone reads this as "the tests failed".
    if (result.exitCode !== 0 && !this.container.running) {
      throw new ForgeError("unavailable", "The sandbox stopped while the command was running.");
    }
    return result;
  }

  /**
   * Starts a named background process whose output goes to files. Throws
   * `conflict` while a process of that name is still running.
   */
  async spawn(name: string, command: string[], options: ExecOptions = {}): Promise<void> {
    const state = this.requireRunning();
    const limit = timeLimit(options.timeoutSeconds) ?? "";
    const previous = state.processes[name];
    if (previous) {
      if ((await this.status(name, previous)).state === "running") {
        throw new ForgeError("conflict", `The process ${name} is still running.`);
      }
      await this.run(["rm", "-rf", previous.dir]);
    }

    const dir = `${this.processRoot}/${this.update((fresh) => fresh.nextProcess++)}`;
    const process = await this.guard(() =>
      this.container.exec(["sh", "-c", SPAWN_SCRIPT, "gitflare-spawn", dir, limit, ...command], {
        cwd: options.cwd,
        env: this.env(state, options),
        stdout: "ignore",
        stderr: "ignore",
      }),
    );
    // Nobody awaits the launcher; without this a lost container is an unhandled rejection.
    process.exitCode.catch(() => {});
    this.update((fresh) => {
      fresh.processes[name] = { dir };
      fresh.keepAliveTicks = this.keepAliveTicks;
    });
    await this.options.scheduleKeepAlive(this.keepAliveIntervalMs);
  }

  async processStatus(name: string): Promise<ProcessStatus | null> {
    const record = this.requireRunning().processes[name];
    return record ? this.status(name, record) : null;
  }

  /**
   * Output from `offset`, a byte count, in pieces of at most 256 KiB. A piece
   * never ends inside a character. An unknown name reads as empty.
   */
  async readLog(name: string, stream: "stdout" | "stderr", offset: number): Promise<LogChunk> {
    const record = this.requireRunning().processes[name];
    if (!record) return { text: "", nextOffset: offset };
    const file = `${record.dir}/${stream}.log`;
    const process = await this.guard(() =>
      this.container.exec(
        ["sh", "-c", READ_LOG_SCRIPT, "gitflare-log", file, `${offset + 1}`, `${LOG_CHUNK_BYTES}`],
        { stderr: "ignore" },
      ),
    );
    const output = await this.guard(() => process.output());
    const bytes = new Uint8Array(output.stdout);
    const length = completeUtf8Length(bytes);
    return { text: decoder.decode(bytes.subarray(0, length)), nextOffset: offset + length };
  }

  async writeFile(path: string, content: string): Promise<void> {
    this.requireRunning();
    const parts = chunks(content);
    const steps: [string, string][] =
      parts.length <= 1
        ? [["only", parts[0] ?? ""]]
        : [
            ...parts.map((part, index): [string, string] => [index === 0 ? "first" : "more", part]),
            ["done", ""],
          ];
    for (const [mode, text] of steps) {
      const result = await this.run([
        "sh",
        "-c",
        WRITE_FILE_SCRIPT,
        "gitflare-write",
        path,
        mode,
        text,
      ]);
      if (result.exitCode !== 0) {
        throw new ForgeError("unavailable", `Could not write ${path}: ${result.stderr.trim()}`);
      }
    }
  }

  async readFile(path: string): Promise<string | null> {
    this.requireRunning();
    const result = await this.run(["sh", "-c", READ_FILE_SCRIPT, "gitflare-read", path]);
    if (result.exitCode === NO_SUCH_FILE) return null;
    if (result.exitCode !== 0) {
      throw new ForgeError("unavailable", `Could not read ${path}: ${result.stderr.trim()}`);
    }
    return result.stdout;
  }

  /** Saves the container's disk. Processes are not saved: a restore runs the entrypoint again. */
  async snapshot(): Promise<SandboxSnapshot> {
    const state = this.requireRunning();
    // A file still in the page cache would be saved half-written.
    await this.run(["sync"]);
    const { id } = await this.guard(() => this.container.snapshotContainer({}));
    return { id, image: state.image };
  }

  async stop(): Promise<void> {
    if (this.container.running) await this.container.destroy();
    this.storage.delete(STATE_KEY);
  }

  /**
   * Called when the Durable Object is constructed. A restart (every deploy)
   * leaves the container running but drops its inactivity timeout, and
   * without one the platform stops it seconds later.
   */
  async onWake(): Promise<void> {
    const state = this.load();
    if (!state) return;
    if (!this.container.running) {
      this.storage.delete(STATE_KEY);
      return;
    }
    await this.container.setInactivityTimeout(this.inactivityTimeoutMs);
  }

  /**
   * Keep-alive tick. The alarm itself is the activity that keeps the
   * container up; it is set again while any spawned process is still running,
   * and after that the inactivity timeout stops the container.
   */
  async onAlarm(): Promise<void> {
    const state = this.load();
    if (!state) return;
    if (!this.container.running) {
      this.storage.delete(STATE_KEY);
      return;
    }
    if (state.keepAliveTicks <= 0) return;

    let busy: boolean;
    try {
      await this.container.setInactivityTimeout(this.inactivityTimeoutMs);
      const statuses = await Promise.all(
        Object.entries(state.processes).map(([name, record]) => this.status(name, record)),
      );
      busy = statuses.some((status) => status.state === "running");
    } catch {
      // Not knowing is not a reason to let a run die: ask again next tick.
      busy = this.container.running;
    }
    if (!busy || !this.load()) return;
    this.update((fresh) => {
      fresh.keepAliveTicks -= 1;
    });
    await this.options.scheduleKeepAlive(this.keepAliveIntervalMs);
  }

  private load(): ControllerState | undefined {
    return this.storage.get<ControllerState>(STATE_KEY);
  }

  private save(state: ControllerState): void {
    this.storage.put(STATE_KEY, state);
  }

  /**
   * Reads, changes and writes the state in one synchronous step. State read
   * before an `await` may be stale by the time it is written back: other
   * requests run while this one waits on the container.
   */
  private update<T>(change: (state: ControllerState) => T): T {
    const state = this.requireRunning();
    const result = change(state);
    this.save(state);
    return result;
  }

  private requireRunning(): ControllerState {
    const state = this.load();
    if (!this.container.running || !state) {
      throw new ForgeError("unavailable", "The sandbox is not running.");
    }
    return state;
  }

  /** A process started with `exec` receives none of the container's variables except `PATH`. */
  private env(state: ControllerState, options: ExecOptions): Record<string, string> {
    return {
      HOME: "/root",
      ...(state.egress === "intercepted" ? TRUST_ENV : {}),
      ...options.env,
    };
  }

  /** Turns the runtime's errors for a lost container into one the caller can act on. */
  private async guard<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      throw new ForgeError("unavailable", `The sandbox was lost: ${describe(error)}`);
    }
  }

  private async run(
    command: string[],
    options?: { cwd?: string; env?: Record<string, string> },
  ): Promise<ExecResult> {
    const process = await this.guard(() => this.container.exec(command, options));
    const output = await this.guard(() => process.output());
    return {
      exitCode: output.exitCode,
      stdout: decoder.decode(output.stdout),
      stderr: decoder.decode(output.stderr),
    };
  }

  private async status(name: string, record: ProcessRecord): Promise<ProcessStatus> {
    if (record.exitCode !== undefined) return { state: "exited", exitCode: record.exitCode };
    const { stdout } = await this.run(["sh", "-c", STATUS_SCRIPT, "gitflare-status", record.dir]);
    const [word, code] = stdout.trim().split(" ");
    if (word === "running") return { state: "running" };
    const exitCode = word === "exited" && code !== undefined ? Number.parseInt(code, 10) : KILLED;
    if (this.load()?.processes[name]?.dir === record.dir) {
      this.update((fresh) => {
        fresh.processes[name] = { dir: record.dir, exitCode };
      });
    }
    return { state: "exited", exitCode };
  }
}

/** `timeoutSeconds` as the argument GNU `timeout` takes, or undefined for no limit. */
function timeLimit(seconds: number | undefined): string | undefined {
  if (seconds === undefined) return undefined;
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new ForgeError("invalid", "timeoutSeconds must be a positive number.");
  }
  return String(Math.ceil(seconds));
}
