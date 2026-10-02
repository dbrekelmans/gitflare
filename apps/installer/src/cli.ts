#!/usr/bin/env node

// create-gitflare: asks its questions, creates every resource the forge
// needs in the user's own Cloudflare account, and deploys a release.
// `--dry-run` prints the plan and touches nothing.
// Facts it rests on: spec/research/installer.md.

import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { createCloudflareApi } from "./cloudflare.ts";
import { main, type Options, parseOptions, usage } from "./main.ts";
import type { CommandRunner, InstallPorts, Prompter, ReleaseFiles } from "./plan.ts";
import { createFileAnswerStore } from "./store.ts";

function terminalPrompter(): Prompter {
  const ask = async (question: string) => {
    const readline = createInterface({ input: process.stdin, output: process.stdout });
    try {
      return await readline.question(question);
    } finally {
      readline.close();
    }
  };
  return {
    async text(question, options) {
      const reply = await ask(`${question}${options?.default ? ` [${options.default}]` : ""}: `);
      return reply.trim() === "" ? (options?.default ?? "") : reply;
    },
    async select(question, choices) {
      const list = choices.map((choice, index) => `  ${index + 1}. ${choice.label}`).join("\n");
      for (;;) {
        const choice = choices[Number(await ask(`${question}\n${list}\n> `)) - 1];
        if (choice) return choice.value;
      }
    },
    async confirm(question) {
      return /^y(es)?$/i.test((await ask(`${question} [y/N] `)).trim());
    },
    note: (message) => void process.stdout.write(`${message}\n`),
  };
}

function releaseFiles(directory: string): ReleaseFiles {
  return {
    async read(name) {
      try {
        return await readFile(join(directory, name), "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    },
    write: (name, text) => writeFile(join(directory, name), text),
  };
}

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
  const ports: InstallPorts = {
    api: createCloudflareApi({
      token: env.CLOUDFLARE_API_TOKEN ?? "",
      fetch,
      baseUrl: env.CLOUDFLARE_API_BASE_URL,
    }),
    commands: commandRunner(release),
    prompt: terminalPrompter(),
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
  }
}

process.exitCode = await run();
