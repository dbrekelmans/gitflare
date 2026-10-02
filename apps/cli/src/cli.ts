#!/usr/bin/env node
import { notImplemented } from "@gitflare/core";
import type { CliContext } from "./context.ts";
import { run } from "./run.ts";

// The real context: process streams, the network, the OS keychain. The parts
// that are not trivial are stubs for the `cli` build task.
const ctx: CliContext = {
  stdin: async () => {
    let text = "";
    for await (const chunk of process.stdin) text += chunk;
    return text;
  },
  stdout: (text) => void process.stdout.write(text),
  stderr: (text) => void process.stderr.write(text),
  env: process.env,
  cwd: process.cwd(),
  fetch,
  exec: async () => notImplemented("CliContext.exec"),
  secrets: {
    get: async () => notImplemented("SecretStore.get"),
    set: async () => notImplemented("SecretStore.set"),
    delete: async () => notImplemented("SecretStore.delete"),
  },
  openBrowser: async () => notImplemented("CliContext.openBrowser"),
};

process.exitCode = await run(ctx, process.argv.slice(2));
