import { createHash } from "node:crypto";
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { createInterface } from "node:readline";
import type { Prompter, ReleaseFiles } from "./plan.ts";

/**
 * Questions on a terminal, or on piped answers one per line. When the input
 * ends before a question is answered, the question fails with an error that
 * says so, instead of waiting for ever.
 */
export function terminalPrompter(
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
): Prompter & { close(): void } {
  const lines: string[] = [];
  const waiting: { resolve: (line: string) => void; reject: (error: Error) => void }[] = [];
  let ended = false;
  const readline = createInterface({ input, terminal: false });
  readline.on("line", (line) => {
    const next = waiting.shift();
    if (next) next.resolve(line);
    else lines.push(line);
  });
  readline.on("close", () => {
    ended = true;
    for (const next of waiting.splice(0)) next.reject(inputEnded());
  });

  const ask = (question: string) => {
    output.write(question);
    const line = lines.shift();
    if (line !== undefined) return Promise.resolve(line);
    if (ended) return Promise.reject(inputEnded());
    return new Promise<string>((resolve, reject) => waiting.push({ resolve, reject }));
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
    note: (message) => void output.write(`${message}\n`),
    close: () => readline.close(),
  };
}

function inputEnded(): Error {
  return new Error(
    "the input ended before every question was answered. Run create-gitflare in a terminal, " +
      "or pass --answers with a file that holds the answers.",
  );
}

export function releaseFiles(directory: string): ReleaseFiles {
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
    remove: (name) => rm(join(directory, name), { recursive: true, force: true }),
    async digest(name) {
      const root = join(directory, name);
      const files = (await readdir(root, { recursive: true, withFileTypes: true }))
        .filter((entry) => entry.isFile())
        .map((entry) => join(entry.parentPath, entry.name))
        .sort();
      const hash = createHash("sha256");
      for (const file of files) {
        hash
          .update(`${relative(root, file)}\0`)
          .update(await readFile(file))
          .update("\0");
      }
      return hash.digest("hex");
    },
  };
}
