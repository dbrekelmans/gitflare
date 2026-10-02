import { ForgeError, type SandboxId } from "@gitflare/core";
import {
  checkStartOptions,
  type ExecOptions,
  type ExecResult,
  type LogChunk,
  type ProcessStatus,
  type Sandbox,
  type SandboxHost,
  type SandboxSnapshot,
  type SandboxStartOptions,
} from "@gitflare/core/ports";

export interface RecordedCommand {
  sandboxId: SandboxId;
  kind: "exec" | "spawn";
  /** The process name for a `spawn`. */
  name?: string;
  command: string[];
  options: ExecOptions;
}

/** What a handler answers with. Anything left out is the default: exit 0, no output. */
export interface ScriptedResult extends Partial<ExecResult> {
  /**
   * For a `spawn`: the process is still running, with `stdout` and `stderr`
   * as its output so far, until `FakeSandboxHost.finish` ends it.
   */
  running?: boolean;
}

/**
 * Decides what a command does. Return a result to answer it; return undefined
 * to let the next handler, and finally the default (exit 0, no output), answer.
 * A command that cannot be launched is answered as the real sandbox answers
 * it: `{ exitCode: EXIT_NOT_LAUNCHED, stderr: "…" }`, not by throwing.
 */
export type CommandHandler = (command: RecordedCommand) => ScriptedResult | undefined;

interface FakeProcess extends ExecResult {
  running: boolean;
}

class FakeSandbox implements Sandbox {
  running = false;
  started: SandboxStartOptions | null = null;
  readonly files = new Map<string, string>();
  readonly processes = new Map<string, FakeProcess>();

  constructor(
    readonly id: SandboxId,
    private readonly host: FakeSandboxHost,
  ) {}

  async start(options: SandboxStartOptions): Promise<void> {
    checkStartOptions(options);
    if (this.running) throw new ForgeError("conflict", `Sandbox ${this.id} is already running.`);
    this.running = true;
    this.started = options;
  }

  async isRunning(): Promise<boolean> {
    return this.running;
  }

  async exec(command: string[], options: ExecOptions = {}): Promise<ExecResult> {
    this.requireRunning();
    const { running: _running, ...result } = this.host.run({
      sandboxId: this.id,
      kind: "exec",
      command,
      options,
    });
    return result;
  }

  async spawn(name: string, command: string[], options: ExecOptions = {}): Promise<void> {
    this.requireRunning();
    if (this.processes.get(name)?.running) {
      throw new ForgeError("conflict", `Process ${name} is still running in sandbox ${this.id}.`);
    }
    this.processes.set(
      name,
      this.host.run({ sandboxId: this.id, kind: "spawn", name, command, options }),
    );
  }

  async processStatus(name: string): Promise<ProcessStatus | null> {
    this.requireRunning();
    const process = this.processes.get(name);
    if (!process) return null;
    return process.running ? { state: "running" } : { state: "exited", exitCode: process.exitCode };
  }

  async readLog(name: string, stream: "stdout" | "stderr", offset: number): Promise<LogChunk> {
    this.requireRunning();
    const text = (this.processes.get(name)?.[stream] ?? "").slice(offset);
    return { text, nextOffset: offset + text.length };
  }

  async writeFile(path: string, content: string): Promise<void> {
    this.requireRunning();
    this.files.set(path, content);
  }

  async readFile(path: string): Promise<string | null> {
    this.requireRunning();
    return this.files.get(path) ?? null;
  }

  async snapshot(): Promise<SandboxSnapshot> {
    this.requireRunning();
    return this.host.takeSnapshot(this);
  }

  async stop(): Promise<void> {
    this.running = false;
    this.files.clear();
    this.processes.clear();
  }

  private requireRunning(): void {
    if (!this.running) throw new ForgeError("unavailable", `Sandbox ${this.id} is not running.`);
  }
}

/**
 * Sandboxes that run nothing. Commands are recorded and answered by handlers
 * the test registers; a background process finishes the moment it is spawned,
 * with its whole output already in the log, unless its handler says it is
 * still `running`.
 *
 * It refuses what the real controller refuses: once a sandbox is not running
 * (never started, stopped, or lost), every method except `isRunning`, `start`
 * and `stop` throws `unavailable`.
 */
export class FakeSandboxHost implements SandboxHost {
  /** Every command any sandbox was asked to run, in order. */
  readonly commands: RecordedCommand[] = [];
  private readonly sandboxes = new Map<SandboxId, FakeSandbox>();
  private readonly handlers: CommandHandler[] = [];
  private readonly snapshots = new Map<string, Map<string, string>>();

  get(id: SandboxId): Sandbox {
    let sandbox = this.sandboxes.get(id);
    if (!sandbox) {
      sandbox = new FakeSandbox(id, this);
      this.sandboxes.set(id, sandbox);
    }
    return sandbox;
  }

  /** Registers a handler. Later registrations are asked first. */
  on(handler: CommandHandler): this {
    this.handlers.unshift(handler);
    return this;
  }

  /** Answers any command whose joined text contains `fragment`. */
  onCommand(fragment: string, result: ScriptedResult): this {
    return this.on((command) =>
      command.command.join(" ").includes(fragment) ? result : undefined,
    );
  }

  /** What a sandbox was last started with, or null if it never was. */
  startOptions(id: SandboxId): SandboxStartOptions | null {
    return this.sandboxes.get(id)?.started ?? null;
  }

  /**
   * Ends a process a handler left `running`, optionally replacing its exit
   * code and output: `finish(id, "agent", { exitCode: 1 })`.
   */
  finish(id: SandboxId, name: string, result: Partial<ExecResult> = {}): void {
    const process = this.sandboxes.get(id)?.processes.get(name);
    if (!process) throw new Error(`FakeSandboxHost: sandbox ${id} has no process named ${name}`);
    Object.assign(process, result, { running: false });
  }

  /** The container went away on its own: the same as a stop nobody asked for. */
  async lose(id: SandboxId): Promise<void> {
    await this.sandboxes.get(id)?.stop();
  }

  run(command: RecordedCommand): FakeProcess {
    this.commands.push(command);
    for (const handler of this.handlers) {
      const result = handler(command);
      if (result) return { exitCode: 0, stdout: "", stderr: "", running: false, ...result };
    }
    return { exitCode: 0, stdout: "", stderr: "", running: false };
  }

  takeSnapshot(sandbox: FakeSandbox): SandboxSnapshot {
    const id = `snap_${this.snapshots.size + 1}`;
    this.snapshots.set(id, new Map(sandbox.files));
    return { id, image: sandbox.started?.image ?? "" };
  }
}
