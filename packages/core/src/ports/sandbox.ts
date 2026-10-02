import type { ModelAttribution } from "../domain/model-call";
import type { WorkspaceSettings } from "../domain/organisation";
import type { GitTokenScope } from "../domain/repository";
import { ForgeError } from "../errors";
import type { SandboxId } from "../ids";

export type SandboxInstance = "lite" | "standard-1" | "standard-2" | "standard-3" | "standard-4";

/**
 * What a sandbox may reach. Credentials never enter the container: each grant
 * is a request the forge recognises on the way out and authenticates itself.
 */
export type EgressGrant =
  /** Git over HTTPS to one repository; the forge adds a token of this scope. */
  | { kind: "git"; repo: string; scope: GitTokenScope }
  /** Model calls through the deployment's gateway, tagged with this attribution. */
  | { kind: "models"; attribution: ModelAttribution }
  /** Plain outbound HTTPS to one host, for package registries. Globs allowed. */
  | { kind: "host"; host: string };

/**
 * What to boot a sandbox from: the deployment's prepared workspace. Throws
 * `unavailable` when no administrator has prepared it yet, so a CI run or a
 * hosted session fails with a reason a person can act on.
 */
export function workspaceStart(
  workspace: WorkspaceSettings,
): Pick<SandboxStartOptions, "image" | "snapshot"> {
  if (!workspace.snapshot) {
    throw new ForgeError(
      "unavailable",
      "The workspace has not been prepared yet. An administrator can prepare it in Settings.",
    );
  }
  return { image: workspace.image, snapshot: workspace.snapshot };
}

export interface SandboxStartOptions {
  /** What to boot: the managed base image, or a named image from the Worker's container configuration. */
  image: string;
  instance: SandboxInstance;
  egress: EgressGrant[];
  /** Start from a saved filesystem instead of the image. */
  snapshot?: SandboxSnapshot;
}

/** Plain data; safe to store. Tied to the image it was taken from. */
export interface SandboxSnapshot {
  id: string;
  image: string;
}

export interface ExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  /** The command and its children are killed after this long. */
  timeoutSeconds?: number;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type ProcessStatus = { state: "running" } | { state: "exited"; exitCode: number };

export interface LogChunk {
  text: string;
  /** Pass back as `offset` to read what was written since. */
  nextOffset: number;
}

/**
 * One container. Nothing running inside it keeps it alive and its disk does
 * not survive a stop, so long work is started with `spawn`, which writes its
 * output to files, and progress is read back with `processStatus` and `readLog`.
 */
export interface Sandbox {
  readonly id: SandboxId;
  start(options: SandboxStartOptions): Promise<void>;
  isRunning(): Promise<boolean>;
  /** Runs a short command to completion and buffers its output. Not for builds or agents. */
  exec(command: string[], options?: ExecOptions): Promise<ExecResult>;
  /** Starts a named background process. A name can be reused once its process has exited. */
  spawn(name: string, command: string[], options?: ExecOptions): Promise<void>;
  processStatus(name: string): Promise<ProcessStatus | null>;
  readLog(name: string, stream: "stdout" | "stderr", offset: number): Promise<LogChunk>;
  writeFile(path: string, content: string): Promise<void>;
  readFile(path: string): Promise<string | null>;
  snapshot(): Promise<SandboxSnapshot>;
  /** Stops the container and discards its disk. */
  stop(): Promise<void>;
}

export interface SandboxHost {
  /** The sandbox with this id; it is created on first `start`. */
  get(id: SandboxId): Sandbox;
}
