import type { SandboxId } from "@gitflare/core";
import { createFakePorts } from "@gitflare/testing";
import { expect, it } from "vitest";
import { createSandboxHost, type SandboxStub } from "./host";

it("addresses each sandbox's Durable Object by the sandbox id and forwards every call", async () => {
  const { sandboxes: fake } = createFakePorts();
  fake.onCommand("uname", { stdout: "Linux\n" });
  const asked: SandboxId[] = [];
  const host = createSandboxHost((id): SandboxStub => {
    asked.push(id);
    return fake.get(id);
  });

  const sandbox = host.get("sbx_one");
  expect(sandbox.id).toBe("sbx_one");
  expect(asked).toEqual([]);

  await sandbox.start({ image: "image", instance: "lite", egress: [] });
  expect(await sandbox.isRunning()).toBe(true);
  expect(await host.get("sbx_two").isRunning()).toBe(false);
  expect((await sandbox.exec(["uname"], { cwd: "/" })).stdout).toBe("Linux\n");
  await sandbox.spawn("job", ["make"], { timeoutSeconds: 5 });
  expect(await sandbox.processStatus("job")).toEqual({ state: "exited", exitCode: 0 });
  expect(await sandbox.readLog("job", "stdout", 0)).toEqual({ text: "", nextOffset: 0 });
  await sandbox.writeFile("/a", "b");
  expect(await sandbox.readFile("/a")).toBe("b");
  expect(await sandbox.snapshot()).toEqual({ id: expect.any(String), image: "image" });
  await sandbox.stop();
  expect(await sandbox.isRunning()).toBe(false);

  expect(new Set(asked)).toEqual(new Set(["sbx_one", "sbx_two"]));
  expect(
    fake.commands.map((command) => [command.sandboxId, command.kind, command.options]),
  ).toEqual([
    ["sbx_one", "exec", { cwd: "/" }],
    ["sbx_one", "spawn", { timeoutSeconds: 5 }],
  ]);
});
