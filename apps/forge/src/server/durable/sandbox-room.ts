import { DurableObject } from "cloudflare:workers";
import { notImplemented } from "@gitflare/core";
import type {
  ExecOptions,
  ExecResult,
  LogChunk,
  ProcessStatus,
  SandboxSnapshot,
  SandboxStartOptions,
} from "@gitflare/core/ports";

/**
 * One per sandbox, named by sandbox id: the Durable Object that owns one
 * container. Each method forwards to `SandboxController` from
 * `@gitflare/sandbox`, constructed with `this.ctx.container`, and `alarm`
 * forwards to its `onAlarm`. Locally there is no container (`ctx.container`
 * is undefined) and the forge uses the fake sandbox host instead of this
 * class. Build task: `sandbox`.
 */
export class SandboxRoom extends DurableObject<Env> {
  async start(_options: SandboxStartOptions): Promise<void> {
    return notImplemented("SandboxRoom.start");
  }

  async isRunning(): Promise<boolean> {
    return notImplemented("SandboxRoom.isRunning");
  }

  async exec(_command: string[], _options?: ExecOptions): Promise<ExecResult> {
    return notImplemented("SandboxRoom.exec");
  }

  async spawn(_name: string, _command: string[], _options?: ExecOptions): Promise<void> {
    return notImplemented("SandboxRoom.spawn");
  }

  async processStatus(_name: string): Promise<ProcessStatus | null> {
    return notImplemented("SandboxRoom.processStatus");
  }

  async readLog(_name: string, _stream: "stdout" | "stderr", _offset: number): Promise<LogChunk> {
    return notImplemented("SandboxRoom.readLog");
  }

  async writeFile(_path: string, _content: string): Promise<void> {
    return notImplemented("SandboxRoom.writeFile");
  }

  async readFile(_path: string): Promise<string | null> {
    return notImplemented("SandboxRoom.readFile");
  }

  async snapshot(): Promise<SandboxSnapshot> {
    return notImplemented("SandboxRoom.snapshot");
  }

  async stop(): Promise<void> {
    return notImplemented("SandboxRoom.stop");
  }

  async alarm(): Promise<void> {
    return notImplemented("SandboxRoom.alarm");
  }
}
