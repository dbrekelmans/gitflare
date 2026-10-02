import type { SandboxId } from "@gitflare/core";
import type {
  ExecOptions,
  ExecResult,
  LogChunk,
  ProcessStatus,
  Sandbox,
  SandboxHost,
  SandboxSnapshot,
  SandboxStartOptions,
} from "@gitflare/core/ports";

export interface RecordedCommand {
  sandboxId: SandboxId;
  kind: "exec" | "spawn";
  /** The process name for a `spawn`. */
  name?: string;
  command: string[];
  options: ExecOptions;
}

/**
 * Decides what a command does. Return a result to answer it; return undefined
 * to let the next handler, and finally the default (exit 0, no output), answer.
 */
export type CommandHandler = (command: RecordedCommand) => Partial<ExecResult> | undefined;

class FakeSandbox implements Sandbox {
  running = false;
  started: SandboxStartOptions | null = null;
  readonly files = new Map<string, string>();
  private readonly processes = new Map<string, ExecResult>();

  constructor(
    readonly id: SandboxId,
    private readonly host: FakeSandboxHost,
  ) {}

  async start(options: SandboxStartOptions): Promise<void> {
    if (this.running) throw new Error(`sandbox ${this.id} is already running`);
    this.running = true;
    this.started = options;
  }

  async isRunning(): Promise<boolean> {
    return this.running;
  }

  async exec(command: string[], options: ExecOptions = {}): Promise<ExecResult> {
    this.requireRunning();
    return this.host.run({ sandboxId: this.id, kind: "exec", command, options });
  }

  async spawn(name: string, command: string[], options: ExecOptions = {}): Promise<void> {
    this.requireRunning();
    this.processes.set(
      name,
      this.host.run({ sandboxId: this.id, kind: "spawn", name, command, options }),
    );
  }

  async processStatus(name: string): Promise<ProcessStatus | null> {
    const result = this.processes.get(name);
    return result ? { state: "exited", exitCode: result.exitCode } : null;
  }

  async readLog(name: string, stream: "stdout" | "stderr", offset: number): Promise<LogChunk> {
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
    if (!this.running) throw new Error(`sandbox ${this.id} is not running`);
  }
}

/**
 * Sandboxes that run nothing. Commands are recorded and answered by handlers
 * the test registers; a background process finishes the moment it is spawned,
 * with its whole output already in the log.
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
  onCommand(fragment: string, result: Partial<ExecResult>): this {
    return this.on((command) =>
      command.command.join(" ").includes(fragment) ? result : undefined,
    );
  }

  /** What a sandbox was last started with, or null if it never was. */
  startOptions(id: SandboxId): SandboxStartOptions | null {
    return this.sandboxes.get(id)?.started ?? null;
  }

  run(command: RecordedCommand): ExecResult {
    this.commands.push(command);
    for (const handler of this.handlers) {
      const result = handler(command);
      if (result) return { exitCode: 0, stdout: "", stderr: "", ...result };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  }

  takeSnapshot(sandbox: FakeSandbox): SandboxSnapshot {
    const id = `snap_${this.snapshots.size + 1}`;
    this.snapshots.set(id, new Map(sandbox.files));
    return { id, image: sandbox.started?.image ?? "" };
  }
}
