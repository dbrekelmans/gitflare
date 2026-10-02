/// <reference types="@cloudflare/vitest-plugin/types" />
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { SandboxStartOptions } from "@gitflare/core/ports";
import { expect, it } from "vitest";
import type { SandboxRoom } from "./sandbox-room";

// Runs in workerd, where there are Durable Objects, storage and alarms but no
// containers: what is checked here is the shell's wiring, not a container.

const options: SandboxStartOptions = {
  image: "cloudflare/debian-trixie",
  instance: "standard-1",
  egress: [{ kind: "host", host: "registry.npmjs.org" }],
};

/** Calls the object from inside, where a rejection can be caught: one crossing RPC is reported as unhandled. */
function failure(name: string, call: (room: SandboxRoom) => Promise<unknown>) {
  return runInDurableObject(env.SANDBOX.getByName(name), async (room: SandboxRoom) => {
    const error = await call(room).then(
      () => null,
      (thrown: unknown) => thrown as { code?: string; message?: string },
    );
    return { code: error?.code, message: error?.message };
  });
}

it("answers for a sandbox that was never started", async () => {
  const sandbox = env.SANDBOX.getByName("sbx_never_started");
  expect(await sandbox.isRunning()).toBe(false);
  expect(await failure("sbx_never_started", (room) => room.exec(["true"]))).toEqual({
    code: "unavailable",
    message: "The sandbox is not running.",
  });
  await sandbox.stop();
  await runInDurableObject(sandbox, (room: SandboxRoom) => room.alarm());
  expect(await sandbox.isRunning()).toBe(false);
});

it("says why it cannot start where there is no container runtime", async () => {
  expect(await failure("sbx_no_runtime", (room) => room.start(options))).toEqual({
    code: "unavailable",
    message: "The sandbox could not start: This deployment has no container runtime.",
  });
  expect(await env.SANDBOX.getByName("sbx_no_runtime").isRunning()).toBe(false);
});

it("refuses a grant for a repository that does not exist before starting anything", async () => {
  const egress: SandboxStartOptions["egress"] = [
    { kind: "git", repo: "no-such-repo", scope: "read" },
  ];
  expect(await failure("sbx_unknown_repo", (room) => room.start({ ...options, egress }))).toEqual({
    code: "not_found",
    message: "The repository no-such-repo does not exist.",
  });
});
