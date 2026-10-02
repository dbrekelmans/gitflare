import { ForgeError } from "@gitflare/core";
import { createFakePorts } from "@gitflare/testing";
import { expect, it } from "vitest";
import { prepareWorkspace } from "./workspace";

const input = {
  image: "cloudflare/debian-trixie",
  setupScript: "#!/bin/sh\napt-get install -y git\n",
};

it("runs the setup script in a fresh container with Internet access and returns its snapshot", async () => {
  const { sandboxes, ids } = createFakePorts();
  let scriptOnDisk: string | null = null;
  sandboxes.on((command) => {
    if (command.kind === "spawn") {
      // The fake runs nothing; what matters is that the script was there to run.
      void sandboxes
        .get(command.sandboxId)
        .readFile(command.command.at(-1) ?? "")
        .then((text) => {
          scriptOnDisk = text;
        });
    }
    return undefined;
  });

  const snapshot = await prepareWorkspace({ sandboxes, ids }, input);

  const [setup] = sandboxes.commands.filter((command) => command.kind === "spawn");
  if (!setup) throw new Error("the setup script was not started");
  expect(sandboxes.startOptions(setup.sandboxId)).toEqual({
    image: "cloudflare/debian-trixie",
    instance: "standard-1",
    egress: [{ kind: "host", host: "*" }],
  });
  expect(setup.command[0]).toBe("sh");
  expect(scriptOnDisk).toBe(input.setupScript);
  // Killed before the Workflow step that waits for it gives up.
  expect(setup.options.timeoutSeconds).toBeLessThan(600);
  expect(snapshot).toEqual({ id: expect.any(String), image: "cloudflare/debian-trixie" });
  expect(await sandboxes.get(setup.sandboxId).isRunning()).toBe(false);
});

it("fails with the end of the script's output, takes no snapshot and stops the container", async () => {
  const { sandboxes, ids } = createFakePorts();
  sandboxes.on((command) =>
    command.kind === "spawn"
      ? { exitCode: 100, stderr: "E: Unable to locate package git\n" }
      : undefined,
  );

  const error = await prepareWorkspace({ sandboxes, ids }, input).then(
    () => null,
    (thrown: unknown) => thrown,
  );

  expect(error).toBeInstanceOf(ForgeError);
  expect((error as ForgeError).code).toBe("unavailable");
  expect((error as ForgeError).message).toContain("exit code 100");
  expect((error as ForgeError).message).toContain("Unable to locate package git");
  const sandboxId = sandboxes.commands[0]?.sandboxId;
  if (!sandboxId) throw new Error("nothing ran");
  expect(await sandboxes.get(sandboxId).isRunning()).toBe(false);
  // A snapshot of a half-prepared workspace would be booted by every sandbox after it.
  await expect(sandboxes.get(sandboxId).snapshot()).rejects.toThrow();
  expect(sandboxes.commands.some((command) => command.command[0] === "rm")).toBe(false);
});

it("uses a new sandbox for every attempt", async () => {
  const { sandboxes, ids } = createFakePorts();
  await prepareWorkspace({ sandboxes, ids }, input);
  await prepareWorkspace({ sandboxes, ids }, input);
  const used = new Set(sandboxes.commands.map((command) => command.sandboxId));
  expect(used.size).toBe(2);
});
