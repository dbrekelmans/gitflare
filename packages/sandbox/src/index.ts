import { notImplemented, type SandboxId } from "@gitflare/core";
import type {
  EgressGrant,
  ExecOptions,
  ExecResult,
  IdGenerator,
  LogChunk,
  ProcessStatus,
  SandboxHost,
  SandboxSnapshot,
  SandboxStartOptions,
} from "@gitflare/core/ports";

// @gitflare/sandbox — one container, driven through the Durable Object that
// owns it. Sandbox SDK 1.0 is helpers, not a sandbox: starting the container,
// running commands, keeping it alive, snapshots and egress are all this
// package's code over `ctx.container`. The Durable Object class in
// `apps/forge/src/server/durable/sandbox-room.ts` is a thin shell around
// `SandboxController`; everything testable lives here, against `ContainerLike`.
// Facts and signatures: spec/research/sandbox-ci.md. Build task: `sandbox`.

/** The part of the runtime's `ctx.container` this package calls. Copy signatures from the research note. */
export interface ContainerLike {
  readonly running: boolean;
  start(options: {
    image?: string;
    containerSnapshot?: { id: string };
    enableInternet: boolean;
    entrypoint?: string[];
    instance?: string;
  }): void;
  exec(
    command: string[],
    options?: {
      cwd?: string;
      env?: Record<string, string>;
      stdout?: "pipe" | "ignore";
      stderr?: "pipe" | "ignore" | "combined";
    },
  ): Promise<{
    readonly stdout: ReadableStream | null | undefined;
    readonly stderr: ReadableStream | null | undefined;
    readonly exitCode: Promise<number>;
    output(): Promise<{ stdout: ArrayBuffer; stderr: ArrayBuffer; exitCode: number }>;
  }>;
  setInactivityTimeout(durationMs: number): Promise<void>;
  snapshotContainer(options: { name?: string }): Promise<{ id: string; size: number }>;
  destroy(error?: unknown): Promise<void>;
}

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
   * Called on every start: intercepts do not survive a container stop.
   */
  applyEgress(grants: EgressGrant[]): Promise<void>;
  /** Asks the Durable Object to wake the controller again, to keep the container alive. */
  scheduleKeepAlive(delayMs: number): Promise<void>;
}

/**
 * The `Sandbox` port's behaviour for one container. The Durable Object
 * forwards each RPC method here and calls `onAlarm` from its alarm handler.
 */
export class SandboxController {
  constructor(private readonly options: SandboxControllerOptions) {}

  async start(_options: SandboxStartOptions): Promise<void> {
    void this.options;
    return notImplemented("@gitflare/sandbox SandboxController.start");
  }

  async isRunning(): Promise<boolean> {
    return notImplemented("@gitflare/sandbox SandboxController.isRunning");
  }

  async exec(_command: string[], _options?: ExecOptions): Promise<ExecResult> {
    return notImplemented("@gitflare/sandbox SandboxController.exec");
  }

  async spawn(_name: string, _command: string[], _options?: ExecOptions): Promise<void> {
    return notImplemented("@gitflare/sandbox SandboxController.spawn");
  }

  async processStatus(_name: string): Promise<ProcessStatus | null> {
    return notImplemented("@gitflare/sandbox SandboxController.processStatus");
  }

  async readLog(_name: string, _stream: "stdout" | "stderr", _offset: number): Promise<LogChunk> {
    return notImplemented("@gitflare/sandbox SandboxController.readLog");
  }

  async writeFile(_path: string, _content: string): Promise<void> {
    return notImplemented("@gitflare/sandbox SandboxController.writeFile");
  }

  async readFile(_path: string): Promise<string | null> {
    return notImplemented("@gitflare/sandbox SandboxController.readFile");
  }

  async snapshot(): Promise<SandboxSnapshot> {
    return notImplemented("@gitflare/sandbox SandboxController.snapshot");
  }

  async stop(): Promise<void> {
    return notImplemented("@gitflare/sandbox SandboxController.stop");
  }

  /** Keep-alive tick: re-arms the inactivity timeout while any spawned process is still running. */
  async onAlarm(): Promise<void> {
    return notImplemented("@gitflare/sandbox SandboxController.onAlarm");
  }
}

/** A Durable Object stub for the sandbox class, as far as the adapter needs it. */
export type SandboxStub = Omit<SandboxController, "onAlarm">;

/** The `SandboxHost` port over the sandbox Durable Object namespace. */
export function createSandboxHost(_stubFor: (id: SandboxId) => SandboxStub): SandboxHost {
  return notImplemented("@gitflare/sandbox createSandboxHost");
}

export interface EgressDecision {
  /** Forward the request, with these headers set and these removed. */
  allow: boolean;
  setHeaders?: Record<string, string>;
  removeHeaders?: string[];
}

/**
 * Decides what happens to one outbound request from a sandbox, given its
 * grants. Pure: the Worker entrypoint that intercepts the traffic calls this
 * and then mints whatever credential the decision asks for.
 */
export function decideEgress(
  _grants: EgressGrant[],
  _request: { method: string; url: string },
): EgressDecision {
  return notImplemented("@gitflare/sandbox decideEgress");
}

/**
 * The provisioning Workflow's workspace step: boots the managed base image
 * with Internet access, runs `setupScript` (the text of
 * `containers/workspace/setup.sh`), takes a snapshot and stops the container.
 * The caller stores the result in the organisation's `workspace` settings.
 */
export async function prepareWorkspace(
  _deps: { sandboxes: SandboxHost; ids: IdGenerator },
  _input: { image: string; setupScript: string },
): Promise<SandboxSnapshot> {
  return notImplemented("@gitflare/sandbox prepareWorkspace");
}
