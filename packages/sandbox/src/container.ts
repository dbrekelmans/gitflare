import { ForgeError } from "@gitflare/core";
import type { SandboxInstance } from "@gitflare/core/ports";

/** What `ContainerLike.exec` resolves to: the runtime's `ExecProcess`, narrowed. */
export interface ExecProcessLike {
  readonly stdout: ReadableStream | null | undefined;
  readonly stderr: ReadableStream | null | undefined;
  /** Resolves for a non-zero code too. Rejects when the container is lost. */
  readonly exitCode: Promise<number>;
  /** Buffers both streams. Can be called once. */
  output(): Promise<{ stdout: ArrayBuffer; stderr: ArrayBuffer; exitCode: number }>;
}

/** What a container boots from is an image or a snapshot, never both. */
export type ContainerStart = {
  enableInternet: boolean;
  entrypoint?: string[];
  instance?: SandboxInstance;
} & (
  | { image: string; containerSnapshot?: never }
  | { image?: never; containerSnapshot: { id: string } }
);

/**
 * The part of the runtime's `ctx.container` this package calls. Signatures are
 * copied from `@cloudflare/workers-types` as quoted in
 * spec/research/sandbox-ci.md; what each call does on a real account is in
 * spec/research/live/container-git.md.
 */
export interface ContainerLike {
  readonly running: boolean;
  /** Named images from the Worker's container configuration, by name. */
  readonly images?: Record<string, string>;
  /** Returns before the container is ready. Throws when it is already running. */
  start(options: ContainerStart): void;
  /** Runs the executable directly, with no shell. Waits for a container that is still starting. */
  exec(
    command: string[],
    options?: {
      cwd?: string;
      env?: Record<string, string>;
      stdout?: "pipe" | "ignore";
      stderr?: "pipe" | "ignore" | "combined";
    },
  ): Promise<ExecProcessLike>;
  setInactivityTimeout(durationMs: number): Promise<void>;
  /** Throws a `TypeError` when `options` is omitted: pass `{}`. */
  snapshotContainer(options: { name?: string }): Promise<{ id: string; size: number }>;
  destroy(error?: unknown): Promise<void>;
}

/**
 * Stands in for `ctx.container` where the runtime provides none: local
 * development and Worker tests. It is never running and cannot be started, so
 * the Durable Object answers with a reason instead of a `TypeError`.
 */
export const noContainer: ContainerLike = {
  running: false,
  start: unavailable,
  exec: unavailable,
  setInactivityTimeout: unavailable,
  snapshotContainer: unavailable,
  destroy: async () => {},
};

function unavailable(): never {
  throw new ForgeError("unavailable", "This deployment has no container runtime.");
}
