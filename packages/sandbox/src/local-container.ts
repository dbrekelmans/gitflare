import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ContainerLike, ContainerStart, ExecProcessLike } from "./container";
import type { ControllerStorage } from "./controller";

// Test support, not part of the package's exports. The fake `ContainerLike`
// the controller is tested against runs each command for real, on this
// machine, so the shell the controller sends is executed rather than compared
// with itself. Everything else about a container (starting, the inactivity
// timeout, snapshots, being destroyed) is recorded.

type StartOptions = ContainerStart;
type ExecOptions = NonNullable<Parameters<ContainerLike["exec"]>[1]>;

function onPath(tool: string): boolean {
  try {
    execFileSync("sh", ["-c", `command -v ${tool}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** True where the real `setsid` and `/proc` exist, so sessions can be observed. */
export const hasSessions = process.platform === "linux" && onPath("setsid");

const TIMEOUT_SHIM = `#!/usr/bin/env node
// GNU timeout, as far as the controller uses it: timeout --kill-after=N SECONDS COMMAND...
const { spawn } = require("node:child_process");
const [, seconds, command, ...args] = process.argv.slice(2);
const child = spawn(command, args, { stdio: "inherit" });
let timedOut = false;
const timer = setTimeout(() => {
  timedOut = true;
  child.kill("SIGTERM");
}, Number(seconds) * 1000);
child.on("exit", (code, signal) => {
  clearTimeout(timer);
  process.exit(timedOut ? 124 : (code ?? (signal === "SIGKILL" ? 137 : 143)));
});
`;

/**
 * A directory to work in and the PATH commands run with. macOS has neither
 * `setsid` nor GNU `timeout`; where one is missing a stand-in is put first on
 * the PATH. Linux, and so CI, runs the real ones.
 */
export function localEnvironment(): { root: string; path: string } {
  const root = mkdtempSync(join(tmpdir(), "gitflare-sandbox-"));
  const shims = join(root, "shims");
  mkdirSync(shims);
  const shim = (name: string, text: string) => {
    writeFileSync(join(shims, name), text);
    chmodSync(join(shims, name), 0o755);
  };
  if (!onPath("setsid")) shim("setsid", '#!/bin/sh\nexec "$@"\n');
  if (!onPath("timeout")) shim("timeout", TIMEOUT_SHIM);
  return { root, path: `${shims}:${process.env.PATH ?? ""}` };
}

export class LocalContainer implements ContainerLike {
  running = false;
  images?: Record<string, string>;
  /** Everything it was asked to do, in order: `start`, `exec`, `timeout`, `snapshot`, `destroy`. */
  readonly calls: string[] = [];
  readonly starts: StartOptions[] = [];
  readonly execs: { command: string[]; options: ExecOptions }[] = [];
  readonly inactivityTimeouts: number[] = [];
  /** Makes the next `exec` reject, as it does when the container never comes up. */
  failNextExec: Error | null = null;
  /** Makes the container stop the moment it is next asked to run something. */
  dieOnNextExec = false;
  private readonly children = new Set<ChildProcess>();

  constructor(private readonly path: string) {}

  start(options: StartOptions): void {
    if (this.running) throw new Error("start() cannot be called on a container that is running.");
    this.calls.push("start");
    this.starts.push(options);
    this.running = true;
  }

  async exec(command: string[], options: ExecOptions = {}): Promise<ExecProcessLike> {
    if (!this.running) {
      throw new Error("exec() cannot be called on a container that is not running.");
    }
    this.calls.push("exec");
    this.execs.push({ command, options });
    if (this.failNextExec) {
      const error = this.failNextExec;
      this.failNextExec = null;
      throw error;
    }
    if (this.dieOnNextExec) {
      this.dieOnNextExec = false;
      this.running = false;
      command = ["sh", "-c", "exit 137"];
    }

    const [file = "", ...args] = command;
    // As in a container: a process gets `PATH` and what `exec` passes, nothing else.
    const env = { PATH: this.path, TMPDIR: tmpdir(), ...options.env };
    if (options.stderr === "combined") throw new Error("LocalContainer does not combine streams.");
    const child: ChildProcess = spawn(file, args, {
      cwd: options.cwd,
      env,
      stdio: ["ignore", options.stdout ?? "pipe", options.stderr ?? "pipe"],
    });
    this.children.add(child);
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });

    const collect = (stream: NodeJS.ReadableStream | null) => {
      const parts: Buffer[] = [];
      stream?.on("data", (part: Buffer) => parts.push(part));
      return () => new Uint8Array(Buffer.concat(parts)).buffer;
    };
    const stdout = collect(child.stdout);
    const stderr = collect(child.stderr);
    const exitCode = new Promise<number>((resolve) => {
      child.once("close", (code, signal) => {
        this.children.delete(child);
        resolve(code ?? (signal === "SIGKILL" ? 137 : 143));
      });
    });
    return {
      stdout: null,
      stderr: null,
      exitCode,
      output: async () => ({ exitCode: await exitCode, stdout: stdout(), stderr: stderr() }),
    };
  }

  async setInactivityTimeout(durationMs: number): Promise<void> {
    this.calls.push("timeout");
    this.inactivityTimeouts.push(durationMs);
  }

  async snapshotContainer(options: { name?: string }): Promise<{ id: string; size: number }> {
    if (options === undefined) throw new TypeError("snapshotContainer() needs options.");
    if (!this.running) throw new Error("The container is not running.");
    this.calls.push("snapshot");
    return { id: `snapshot-${this.calls.length}`, size: 141 };
  }

  async destroy(): Promise<void> {
    this.calls.push("destroy");
    this.running = false;
    for (const child of this.children) child.kill("SIGKILL");
  }
}

/** Durable Object storage: every read is a copy, as it is there. */
export class MemoryStorage implements ControllerStorage {
  private readonly values = new Map<string, unknown>();

  get<T>(key: string): T | undefined {
    return structuredClone(this.values.get(key)) as T | undefined;
  }

  put<T>(key: string, value: T): void {
    this.values.set(key, structuredClone(value));
  }

  delete(key: string): void {
    this.values.delete(key);
  }
}
