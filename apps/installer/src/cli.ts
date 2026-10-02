#!/usr/bin/env node

// create-gitflare: asks its questions, creates every resource the forge
// needs in the user's own Cloudflare account, and deploys a release.
// `--dry-run` prints the plan and touches nothing.
// Facts it rests on: spec/research/installer.md.

import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createCloudflareApi } from "./cloudflare.ts";
import { main, type Options, parseOptions, usage } from "./main.ts";
import type { CommandRunner, InstallPorts } from "./plan.ts";
import { createFileAnswerStore } from "./store.ts";
import { releaseFiles, terminalPrompter } from "./system.ts";

/** Through `npx`, so the release's own Wrangler is used when it has one. */
function commandRunner(directory: string): CommandRunner {
  return {
    run: (command, args, options) =>
      new Promise((done, fail) => {
        const child = spawn("npx", ["--yes", command, ...args], {
          cwd: options?.cwd ?? directory,
          env: { ...process.env, ...options?.env },
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => {
          stdout += chunk;
        });
        child.stderr.on("data", (chunk) => {
          stderr += chunk;
        });
        child.on("error", fail);
        child.on("close", (exitCode) => done({ exitCode: exitCode ?? 1, stdout, stderr }));
      }),
  };
}

async function run(): Promise<number> {
  let options: Options;
  try {
    options = parseOptions(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`create-gitflare: ${(error as Error).message}\n\n${usage}`);
    return 1;
  }
  const env = process.env;
  // In the repository the release is the forge beside the installer.
  const release = resolve(
    options.release ?? fileURLToPath(new URL("../../forge", import.meta.url)),
  );
  const prompt = terminalPrompter(process.stdin, process.stdout);
  const ports: InstallPorts = {
    api: createCloudflareApi({
      token: env.CLOUDFLARE_API_TOKEN ?? "",
      fetch,
      baseUrl: env.CLOUDFLARE_API_BASE_URL,
    }),
    commands: commandRunner(release),
    prompt,
    store: createFileAnswerStore(
      options.answers ??
        join(env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "create-gitflare", "answers.json"),
    ),
    files: releaseFiles(release),
  };
  try {
    return await main(options, ports, env);
  } catch (error) {
    process.stderr.write(`create-gitflare: ${(error as Error).message}\n`);
    return 1;
  } finally {
    prompt.close();
  }
}

process.exitCode = await run();
