import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ForgeError } from "@gitflare/core";
import {
  type EgressGrant,
  EXIT_NOT_LAUNCHED,
  type ProcessStatus,
  type SandboxStartOptions,
} from "@gitflare/core/ports";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { SandboxController, type SandboxControllerOptions } from "./controller";
import { hasSessions, LocalContainer, localEnvironment, MemoryStorage } from "./local-container";

const environment = localEnvironment();
afterAll(() => rmSync(environment.root, { recursive: true, force: true }));

const INACTIVITY_MS = 600_000;
const INTERVAL_MS = 60_000;
const CA = "/etc/cloudflare/certs/cloudflare-containers-ca.crt";

const gitGrant: EgressGrant = { kind: "git", repo: "forge.fork.01ABC", scope: "write" };
const options: SandboxStartOptions = {
  image: "cloudflare/debian-trixie",
  instance: "standard-1",
  egress: [gitGrant],
};

const containers: LocalContainer[] = [];
afterEach(async () => {
  for (const container of containers.splice(0)) await container.destroy();
});

let sequence = 0;

function setup(overrides: Partial<SandboxControllerOptions> = {}) {
  const container = new LocalContainer(environment.path);
  containers.push(container);
  sequence += 1;
  const processRoot = join(environment.root, `processes-${sequence}`);
  const scratch = join(environment.root, `scratch-${sequence}`);
  mkdirSync(scratch);
  const applied: EgressGrant[][] = [];
  const scheduled: number[] = [];
  const controller = new SandboxController({
    container,
    storage: new MemoryStorage(),
    applyEgress: async (grants) => {
      container.calls.push("egress");
      applied.push(grants);
    },
    scheduleKeepAlive: async (delayMs) => {
      scheduled.push(delayMs);
    },
    processRoot,
    ...overrides,
  });
  return { container, controller, applied, scheduled, processRoot, scratch };
}

async function started(overrides: Partial<SandboxControllerOptions> = {}) {
  const context = setup(overrides);
  await context.controller.start(options);
  return context;
}

async function failure(promise: Promise<unknown>): Promise<ForgeError> {
  const error = await promise.then(
    () => null,
    (thrown: unknown) => thrown,
  );
  if (!(error instanceof ForgeError)) throw new Error(`expected a ForgeError, got ${error}`);
  return error;
}

/** Polls a background process until it has exited. */
async function exited(
  controller: SandboxController,
  name: string,
): Promise<Extract<ProcessStatus, { state: "exited" }>> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const status = await controller.processStatus(name);
    if (status?.state === "exited") return status;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`${name} did not exit`);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Waits for a killed process to be reaped: until then it still answers a signal. */
async function gone(pid: number): Promise<boolean> {
  for (let attempt = 0; attempt < 80 && alive(pid); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return !alive(pid);
}

const shell = (script: string) => ["sh", "-c", script];

describe("start", () => {
  it("boots the image offline behind the egress handler, and is running once a command ran", async () => {
    const { container, controller, applied } = setup();
    expect(await controller.isRunning()).toBe(false);

    await controller.start(options);

    expect(container.starts).toEqual([
      {
        image: "cloudflare/debian-trixie",
        enableInternet: false,
        entrypoint: ["sleep", "infinity"],
        instance: "standard-1",
      },
    ]);
    expect(applied).toEqual([[gitGrant]]);
    // The handler is registered before the container starts, a command proves
    // it is up, and only then is the timeout set.
    expect(container.calls).toEqual(["egress", "start", "exec", "timeout"]);
    expect(container.inactivityTimeouts).toEqual([INACTIVITY_MS]);
    expect(await controller.isRunning()).toBe(true);
  });

  it("boots a snapshot instead of the image when given one", async () => {
    const { container, controller } = setup();
    await controller.start({ ...options, snapshot: { id: "snap_7", image: options.image } });
    expect(container.starts[0]).toMatchObject({ containerSnapshot: { id: "snap_7" } });
    expect(container.starts[0]).not.toHaveProperty("image");
  });

  it("resolves a named image from the Worker's container configuration", async () => {
    const { container, controller } = setup();
    container.images = { workspace: "registry.cloudflare.com/acct/workspace@sha256:abc" };
    await controller.start({ ...options, image: "workspace" });
    expect(container.starts[0]?.image).toBe("registry.cloudflare.com/acct/workspace@sha256:abc");
  });

  it("turns Internet access on, with nothing intercepted, when asked for by name", async () => {
    const { container, controller, applied } = setup();
    await controller.start({ ...options, egress: [], openInternet: true });
    expect(container.starts[0]?.enableInternet).toBe(true);
    expect(applied).toEqual([]);
  });

  it("refuses to combine open Internet access with a credential, before starting anything", async () => {
    const { container, controller } = setup();
    const error = await failure(
      controller.start({ ...options, egress: [gitGrant], openInternet: true }),
    );
    expect(error.code).toBe("invalid");
    expect(container.calls).toEqual([]);
  });

  it("refuses a host grant that matches every host, before starting anything", async () => {
    for (const host of ["*", "**", "*.*"]) {
      const { container, controller } = setup();
      const error = await failure(
        controller.start({ ...options, egress: [{ kind: "host", host }] }),
      );
      expect([host, error.code]).toEqual([host, "invalid"]);
      expect(container.calls).toEqual([]);
    }
  });

  it("refuses to start a container that is already running", async () => {
    const { controller } = await started();
    expect((await failure(controller.start(options))).code).toBe("conflict");
  });

  it("reports a container that never comes up, and leaves nothing running", async () => {
    const { container, controller } = setup();
    container.failNextExec = new Error("The container connection is temporarily unavailable");

    const error = await failure(controller.start(options));

    expect(error.code).toBe("unavailable");
    expect(error.message).toContain("temporarily unavailable");
    expect(container.running).toBe(false);
    expect((await failure(controller.exec(["true"]))).code).toBe("unavailable");
    // Nothing is left that would stop a second attempt.
    await controller.start(options);
    expect(await controller.isRunning()).toBe(true);
  });

  it("clears the process files a snapshot carried over", async () => {
    const { controller, processRoot } = setup();
    mkdirSync(join(processRoot, "1"), { recursive: true });
    writeFileSync(join(processRoot, "1", "exit-code"), "0\n");

    await controller.start(options);
    await controller.spawn("build", shell("sleep 0.4; exit 6"));

    expect(await controller.processStatus("build")).toEqual({ state: "running" });
    expect(await exited(controller, "build")).toEqual({ state: "exited", exitCode: 6 });
  });
});

describe("exec", () => {
  it("returns the exit code and both streams, and runs in the directory and environment given", async () => {
    const { controller, scratch } = await started();
    const result = await controller.exec(
      shell('echo "$GREETING from $(pwd)"; echo oops >&2; exit 7'),
      {
        cwd: scratch,
        env: { GREETING: "hello" },
      },
    );
    expect(result.exitCode).toBe(7);
    expect(result.stdout).toMatch(new RegExp(`^hello from .*${scratch.split("/").at(-1)}\n$`));
    expect(result.stderr).toBe("oops\n");
  });

  it("runs the command itself, not a shell", async () => {
    const { controller } = await started();
    const result = await controller.exec(["printf", "%s|", "a b", "$HOME", "; exit 3"]);
    expect(result).toEqual({ exitCode: 0, stdout: "a b|$HOME|; exit 3|", stderr: "" });
  });

  it("trusts the container CA alone only when every request is intercepted", async () => {
    const print = shell(
      'echo "$HOME|$GIT_SSL_CAINFO|$NODE_EXTRA_CA_CERTS|$SSL_CERT_FILE|$CURL_CA_BUNDLE"',
    );
    const intercepted = await started();
    expect((await intercepted.controller.exec(print)).stdout).toBe(
      `/root|${CA}|${CA}|${CA}|${CA}\n`,
    );

    const open = setup();
    await open.controller.start({ ...options, egress: [], openInternet: true });
    expect((await open.controller.exec(print)).stdout).toBe("/root||||\n");
  });

  it("kills a command that outlives its timeout", async () => {
    const { controller } = await started();
    const before = Date.now();
    const result = await controller.exec(["sleep", "30"], { timeoutSeconds: 1 });
    expect(result.exitCode).toBe(124);
    expect(Date.now() - before).toBeLessThan(10_000);
  });

  it("passes the exit code through when the command finishes in time", async () => {
    const { controller } = await started();
    const result = await controller.exec(shell("echo done; exit 5"), { timeoutSeconds: 20 });
    expect(result).toEqual({ exitCode: 5, stdout: "done\n", stderr: "" });
  });

  it.skipIf(!hasSessions)("kills the children a timed-out command left behind", async () => {
    const { controller, scratch } = await started();
    const pidFile = join(scratch, "child.pid");
    // The shape that survived GNU timeout in the live test: a child detached
    // from the command by a subshell.
    const result = await controller.exec(shell(`(sleep 300 & echo $! >${pidFile}); sleep 300`), {
      timeoutSeconds: 1,
    });
    expect(result.exitCode).toBe(124);
    const child = Number(readFileSync(pidFile, "utf8"));
    expect(child).toBeGreaterThan(1);
    expect(await gone(child)).toBe(true);
  });

  it("rejects a timeout that is not a positive number", async () => {
    const { controller } = await started();
    expect((await failure(controller.exec(["true"], { timeoutSeconds: 0 }))).code).toBe("invalid");
  });

  it("does not report a command's failure when it was the container that stopped", async () => {
    const { container, controller } = await started();
    container.dieOnNextExec = true;
    const error = await failure(controller.exec(["npm", "test"]));
    expect(error.code).toBe("unavailable");
  });

  it("reports a command the runtime cannot launch as a result, not as a lost sandbox", async () => {
    const { controller, scratch } = await started();
    // The runtime itself refuses these: there is no shell in between.
    const missing = await controller.exec(["no-such-command-gitflare", "--version"]);
    expect(missing.exitCode).toBe(EXIT_NOT_LAUNCHED);
    expect(missing.stderr).toContain("no-such-command-gitflare");

    for (const timeoutSeconds of [undefined, 5]) {
      const badCwd = await controller.exec(["true"], {
        cwd: join(scratch, "no-such-directory"),
        timeoutSeconds,
      });
      expect([timeoutSeconds, badCwd.exitCode]).toEqual([timeoutSeconds, EXIT_NOT_LAUNCHED]);
    }
    expect(await controller.isRunning()).toBe(true);
    expect((await controller.exec(["true"])).exitCode).toBe(0);
  });

  it("still reports a lost sandbox when the runtime refuses because the container is gone", async () => {
    const { container, controller } = await started();
    container.exec = async () => {
      container.running = false;
      throw new Error("Container is not running");
    };
    expect((await failure(controller.exec(["true"]))).code).toBe("unavailable");
    expect((await failure(controller.spawn("build", ["true"]))).code).toBe("unavailable");
  });

  it("is unavailable before the container starts", async () => {
    const { controller } = setup();
    expect((await failure(controller.exec(["true"]))).code).toBe("unavailable");
  });
});

describe("background processes", () => {
  it("runs a process past the call that started it, and keeps its exit code and output", async () => {
    const { container, controller, scratch } = await started();

    await controller.spawn(
      "test",
      shell('echo "in $(pwd) as $NAME"; sleep 0.4; echo late >&2; exit 3'),
      {
        cwd: scratch,
        env: { NAME: "ci" },
      },
    );

    expect(await controller.processStatus("test")).toEqual({ state: "running" });
    // Its output is not piped to the Durable Object: a pipe dies with the request.
    expect(container.execs.at(-2)?.options).toMatchObject({ stdout: "ignore", stderr: "ignore" });
    expect(await exited(controller, "test")).toEqual({ state: "exited", exitCode: 3 });
    const out = await controller.readLog("test", "stdout", 0);
    expect(out.text).toMatch(/^in .*scratch-\d+ as ci\n$/);
    expect((await controller.readLog("test", "stderr", 0)).text).toBe("late\n");
  });

  it("reads a log in order from where the last read stopped", async () => {
    const { controller } = await started();
    await controller.spawn("steps", shell("echo one; sleep 0.5; echo two"));

    let first = await controller.readLog("steps", "stdout", 0);
    while (first.text === "") first = await controller.readLog("steps", "stdout", 0);
    expect(first).toEqual({ text: "one\n", nextOffset: 4 });

    await exited(controller, "steps");
    expect(await controller.readLog("steps", "stdout", first.nextOffset)).toEqual({
      text: "two\n",
      nextOffset: 8,
    });
    expect(await controller.readLog("steps", "stdout", 8)).toEqual({ text: "", nextOffset: 8 });
  });

  it("never splits a character between two reads of a long log", async () => {
    const { controller } = await started();
    // One byte, then two-byte characters: the 256 KiB boundary falls inside one.
    const text = `a${"é".repeat(200_000)}`;
    await controller.spawn("long", [
      "node",
      "-e",
      `process.stdout.write("a" + "é".repeat(200000))`,
    ]);
    await exited(controller, "long");

    const first = await controller.readLog("long", "stdout", 0);
    const second = await controller.readLog("long", "stdout", first.nextOffset);

    expect(first.nextOffset).toBe(256 * 1024 - 1);
    expect(first.text.includes("�") || second.text.includes("�")).toBe(false);
    expect(first.text + second.text).toBe(text);
    expect(second.nextOffset).toBe(Buffer.byteLength(text));
  });

  it("kills a process that outlives its timeout and records why", async () => {
    const { controller } = await started();
    await controller.spawn("hang", ["sleep", "30"], { timeoutSeconds: 1 });
    expect(await exited(controller, "hang")).toEqual({ state: "exited", exitCode: 124 });
  });

  it.skipIf(!hasSessions)("kills the children a timed-out process left behind", async () => {
    const { controller, scratch } = await started();
    const pidFile = join(scratch, "child.pid");
    await controller.spawn("hang", shell(`(sleep 300 & echo $! >${pidFile}); sleep 300`), {
      timeoutSeconds: 1,
    });
    expect(await exited(controller, "hang")).toEqual({ state: "exited", exitCode: 124 });
    expect(await gone(Number(readFileSync(pidFile, "utf8")))).toBe(true);
  });

  it("refuses a name whose process is still running, and reuses it afterwards", async () => {
    const { controller } = await started();
    await controller.spawn("step", shell("echo first; sleep 0.4"));

    expect((await failure(controller.spawn("step", shell("echo second")))).code).toBe("conflict");

    await exited(controller, "step");
    await controller.spawn("step", shell("echo second; exit 9"));
    expect(await exited(controller, "step")).toEqual({ state: "exited", exitCode: 9 });
    expect((await controller.readLog("step", "stdout", 0)).text).toBe("second\n");
  });

  it("reports a command that cannot be run as exited, not as running forever", async () => {
    const { controller } = await started();
    await controller.spawn("typo", ["no-such-command-gitflare"]);
    expect((await exited(controller, "typo")).exitCode).toBe(127);
    expect((await controller.readLog("typo", "stderr", 0)).text).toContain(
      "no-such-command-gitflare",
    );
  });

  it("reports a process the runtime cannot launch as exited with EXIT_NOT_LAUNCHED", async () => {
    const { controller, scratch, scheduled } = await started();
    await controller.spawn("build", ["true"], { cwd: join(scratch, "no-such-directory") });

    expect(await controller.processStatus("build")).toEqual({
      state: "exited",
      exitCode: EXIT_NOT_LAUNCHED,
    });
    expect((await controller.readLog("build", "stderr", 0)).text).toContain("no-such-directory");
    expect(scheduled).toEqual([]);
    // The name is free again.
    await controller.spawn("build", ["true"]);
    expect(await exited(controller, "build")).toEqual({ state: "exited", exitCode: 0 });
  });

  it("reports a process whose launcher never recorded itself as not launched, after a grace period", async () => {
    const { controller, processRoot } = await started({ launchGraceMs: 300 });
    // The launcher cannot create its directory, so it never writes a file.
    writeFileSync(processRoot, "in the way");

    await controller.spawn("build", ["sleep", "30"]);

    // Until the grace period is over, it may simply not have got that far.
    expect(await controller.processStatus("build")).toEqual({ state: "running" });
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(await controller.processStatus("build")).toEqual({
      state: "exited",
      exitCode: EXIT_NOT_LAUNCHED,
    });
  });

  it("reports a process whose launcher was killed as killed", async () => {
    const { controller, processRoot } = await started();
    await controller.spawn("victim", ["sleep", "30"]);
    expect(await controller.processStatus("victim")).toEqual({ state: "running" });

    const dir = join(processRoot, "1");
    while (!existsSync(join(dir, "pid"))) await new Promise((resolve) => setTimeout(resolve, 10));
    const launcher = Number(readFileSync(join(dir, "launcher"), "utf8").split(" ")[0]);
    process.kill(launcher, "SIGKILL");
    process.kill(Number(readFileSync(join(dir, "pid"), "utf8")), "SIGKILL");

    expect(await exited(controller, "victim")).toEqual({ state: "exited", exitCode: 137 });
  });

  it("knows nothing of a name it never started", async () => {
    const { controller } = await started();
    expect(await controller.processStatus("ghost")).toBeNull();
    expect(await controller.readLog("ghost", "stdout", 12)).toEqual({ text: "", nextOffset: 12 });
  });
});

describe("files", () => {
  it("writes and reads back text no shell may interpret", async () => {
    const { controller, scratch } = await started();
    const path = join(scratch, "deep", "er dir", "file's $HOME.txt");
    const content = "#!/bin/sh\necho \"$1\" 'two' `three` \\n %s %d\n\ttab — ünïcödé 🙂\n";

    await controller.writeFile(path, content);

    expect(await controller.readFile(path)).toBe(content);
    expect(readFileSync(path, "utf8")).toBe(content);
  });

  it("writes a file larger than one argument can carry", async () => {
    const { container, controller, scratch } = await started();
    const path = join(scratch, "large.txt");
    // An emoji is two UTF-16 units; the odd length puts one across a piece boundary.
    const content = `x${"🙂".repeat(40_000)}\n`;
    const before = container.execs.length;

    await controller.writeFile(path, content);

    expect(container.execs.length - before).toBeGreaterThan(2);
    for (const { command } of container.execs.slice(before)) {
      for (const argument of command) expect(Buffer.byteLength(argument)).toBeLessThan(128 * 1024);
    }
    expect(readFileSync(path, "utf8")).toBe(content);
  });

  it("writes an empty file, and overwrites", async () => {
    const { controller, scratch } = await started();
    const path = join(scratch, "empty.txt");
    await controller.writeFile(path, "something");
    await controller.writeFile(path, "");
    expect(await controller.readFile(path)).toBe("");
  });

  it("reads a missing file, or a directory, as null", async () => {
    const { controller, scratch } = await started();
    expect(await controller.readFile(join(scratch, "nope.txt"))).toBeNull();
    expect(await controller.readFile(scratch)).toBeNull();
  });
});

describe("snapshot", () => {
  it("saves the disk and says which image it belongs to", async () => {
    const { container, controller } = setup();
    await controller.start({ ...options, snapshot: { id: "snap_base", image: options.image } });

    const snapshot = await controller.snapshot();

    expect(snapshot).toEqual({ id: expect.stringMatching(/^snapshot-/), image: options.image });
    // The disk is flushed before it is saved.
    expect(container.execs.at(-1)?.command).toEqual(["sync"]);
    expect(container.calls.at(-1)).toBe("snapshot");
    expect(await controller.isRunning()).toBe(true);
  });

  it("cannot save a container that is not running", async () => {
    const { controller } = setup();
    expect((await failure(controller.snapshot())).code).toBe("unavailable");
  });
});

describe("keeping the container alive", () => {
  it("sets an alarm when a process is spawned, and not for a command that runs to completion", async () => {
    const { controller, scheduled } = await started();
    await controller.exec(["true"]);
    expect(scheduled).toEqual([]);
    await controller.spawn("job", shell("sleep 0.3"));
    expect(scheduled).toEqual([INTERVAL_MS]);
  });

  it("renews the timeout and the alarm while a process runs, and stops once it has exited", async () => {
    const { container, controller, scheduled } = await started();
    await controller.spawn("job", shell("sleep 0.6"));

    await controller.onAlarm();
    expect(scheduled).toEqual([INTERVAL_MS, INTERVAL_MS]);
    expect(container.inactivityTimeouts).toEqual([INACTIVITY_MS, INACTIVITY_MS]);

    await exited(controller, "job");
    await controller.onAlarm();
    // No further alarm: the inactivity timeout now stops the container.
    expect(scheduled).toEqual([INTERVAL_MS, INTERVAL_MS]);
  });

  it("keeps going while any one of several processes runs", async () => {
    const { controller, scheduled } = await started();
    await controller.spawn("short", ["true"]);
    await controller.spawn("long", shell("sleep 0.6"));
    await exited(controller, "short");
    scheduled.length = 0;

    await controller.onAlarm();

    expect(scheduled).toEqual([INTERVAL_MS]);
  });

  it("gives up on a process nobody collects after the longest time allowed", async () => {
    const { controller, scheduled } = await started({
      keepAliveIntervalMs: 1_000,
      maxKeepAliveMs: 2_000,
    });
    await controller.spawn("runaway", ["sleep", "30"]);
    scheduled.length = 0;

    await controller.onAlarm();
    await controller.onAlarm();
    await controller.onAlarm();
    await controller.onAlarm();

    expect(scheduled).toEqual([1_000, 1_000]);
    expect(await controller.processStatus("runaway")).toEqual({ state: "running" });
  });

  it("starts the allowance again with each spawn", async () => {
    const { controller, scheduled } = await started({
      keepAliveIntervalMs: 1_000,
      maxKeepAliveMs: 1_000,
    });
    await controller.spawn("one", ["sleep", "30"]);
    await controller.onAlarm();
    await controller.onAlarm();
    await controller.spawn("two", ["sleep", "30"]);
    scheduled.length = 0;

    await controller.onAlarm();

    expect(scheduled).toEqual([1_000]);
  });

  it("uses the configured timeout and interval", async () => {
    const { container, controller, scheduled } = await started({
      inactivityTimeoutMs: 90_000,
      keepAliveIntervalMs: 30_000,
    });
    await controller.spawn("job", shell("sleep 0.3"));
    expect(container.inactivityTimeouts).toEqual([90_000]);
    expect(scheduled).toEqual([30_000]);
  });

  it("sets the timeout again when the Durable Object restarts under a running container", async () => {
    const { container, scheduled, processRoot } = await started();
    const storage = new MemoryStorage();
    const first = new SandboxController({
      container,
      storage,
      applyEgress: async () => {},
      scheduleKeepAlive: async () => {},
      processRoot,
    });
    await container.destroy();
    await first.start(options);
    await first.spawn("job", shell("sleep 0.5; exit 4"));
    container.inactivityTimeouts.length = 0;

    // A deploy: a new object, the same storage, the container still running.
    const second = new SandboxController({
      container,
      storage,
      applyEgress: async () => {},
      scheduleKeepAlive: async (delayMs) => {
        scheduled.push(delayMs);
      },
      processRoot,
    });
    await second.onWake();

    expect(container.inactivityTimeouts).toEqual([INACTIVITY_MS]);
    // And it still knows the process the first object started.
    expect(await exited(second, "job")).toEqual({ state: "exited", exitCode: 4 });
  });

  it("forgets a container the platform stopped, and sets no further alarm", async () => {
    const { container, controller, scheduled } = await started();
    await controller.spawn("job", ["sleep", "30"]);
    scheduled.length = 0;
    await container.destroy();

    await controller.onAlarm();
    await controller.onWake();

    expect(scheduled).toEqual([]);
    expect(container.inactivityTimeouts).toEqual([INACTIVITY_MS]);
    expect((await failure(controller.processStatus("job"))).code).toBe("unavailable");
  });

  it("does nothing on an alarm or a wake before anything started", async () => {
    const { container, controller, scheduled } = setup();
    await controller.onAlarm();
    await controller.onWake();
    expect(container.calls).toEqual([]);
    expect(scheduled).toEqual([]);
  });
});

describe("stop", () => {
  it("destroys the container, forgets its processes, and can be repeated", async () => {
    const { container, controller } = await started();
    await controller.spawn("job", ["sleep", "30"]);

    await controller.stop();
    await controller.stop();

    expect(container.running).toBe(false);
    expect(container.calls.filter((call) => call === "destroy")).toHaveLength(1);
    expect(await controller.isRunning()).toBe(false);
    expect((await failure(controller.readFile("/etc/hostname"))).code).toBe("unavailable");

    // A new start is a new container: the old process is not part of it.
    await controller.start(options);
    expect(await controller.processStatus("job")).toBeNull();
  });
});
