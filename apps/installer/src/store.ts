import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AnswerStore } from "./plan.ts";

/**
 * The answers as a JSON file on the installer's machine. It holds no secret:
 * the API token is read from the environment on every run and never written.
 */
export function createFileAnswerStore(path: string): AnswerStore {
  return {
    async load() {
      let text: string;
      try {
        text = await readFile(path, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
      try {
        return JSON.parse(text);
      } catch {
        throw new Error(`${path} is not JSON; fix it or delete it to be asked again`);
      }
    },
    async save(answers) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, `${JSON.stringify(answers, null, 2)}\n`);
    },
  };
}
