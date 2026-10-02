import type { SandboxId } from "@gitflare/core";
import type { Sandbox, SandboxHost } from "@gitflare/core/ports";

/** A Durable Object stub for the sandbox class, as far as the adapter needs it. */
export type SandboxStub = Omit<Sandbox, "id">;

/** The `SandboxHost` port over the sandbox Durable Object namespace. */
export function createSandboxHost(stubFor: (id: SandboxId) => SandboxStub): SandboxHost {
  return {
    // A stub is looked up per call: it is cheap, and one that outlived an
    // error would keep failing.
    get: (id) => ({
      id,
      start: (options) => stubFor(id).start(options),
      isRunning: () => stubFor(id).isRunning(),
      exec: (command, options) => stubFor(id).exec(command, options),
      spawn: (name, command, options) => stubFor(id).spawn(name, command, options),
      processStatus: (name) => stubFor(id).processStatus(name),
      readLog: (name, stream, offset) => stubFor(id).readLog(name, stream, offset),
      writeFile: (path, content) => stubFor(id).writeFile(path, content),
      readFile: (path) => stubFor(id).readFile(path),
      snapshot: () => stubFor(id).snapshot(),
      stop: () => stubFor(id).stop(),
    }),
  };
}
