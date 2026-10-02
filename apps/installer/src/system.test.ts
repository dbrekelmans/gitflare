import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { releaseFiles, terminalPrompter } from "./system.ts";

function streams() {
  const input = new PassThrough();
  const output = new PassThrough();
  let printed = "";
  output.on("data", (chunk) => {
    printed += chunk;
  });
  return { input, output, printed: () => printed };
}

describe("the terminal prompter", () => {
  it("fails a question once the input has ended, instead of waiting for ever", async () => {
    const { input, output } = streams();
    const prompt = terminalPrompter(input, output);
    input.end();
    await expect(prompt.text("Your organisation's name")).rejects.toThrow(
      /input ended before every question was answered/,
    );
    prompt.close();
  });

  it("takes piped answers one line each, and fails the first question past them", async () => {
    const { input, output, printed } = streams();
    const prompt = terminalPrompter(input, output);
    input.end("Acme\n\n2\n");
    expect(await prompt.text("Name")).toBe("Acme");
    expect(await prompt.text("Budget", { default: "200" })).toBe("200");
    expect(
      await prompt.select("Where?", [
        { value: "eu", label: "EU" },
        { value: "us", label: "US" },
      ]),
    ).toBe("us");
    await expect(prompt.confirm("Go ahead?")).rejects.toThrow(/input ended/);
    expect(printed()).toContain("Budget [200]: ");
    prompt.close();
  });
});

describe("release files", () => {
  it("digests a directory by its files' names and contents, and removes it", async () => {
    const root = mkdtempSync(join(tmpdir(), "create-gitflare-"));
    const files = releaseFiles(root);
    mkdirSync(join(root, "out", "nested"), { recursive: true });
    writeFileSync(join(root, "out", "index.js"), "a");
    writeFileSync(join(root, "out", "nested", "chunk.js"), "b");
    const first = await files.digest("out");

    writeFileSync(join(root, "out", "nested", "chunk.js"), "c");
    const changed = await files.digest("out");
    expect(changed).not.toBe(first);

    writeFileSync(join(root, "out", "nested", "chunk.js"), "b");
    expect(await files.digest("out")).toBe(first);

    await files.remove("out");
    await files.remove("out");
    expect(await files.read("out/index.js")).toBeNull();
  });
});

describe("create-gitflare", () => {
  it("exits with a clear error, not a hang, when there is nothing to answer its questions", () => {
    const home = mkdtempSync(join(tmpdir(), "create-gitflare-"));
    const ran = spawnSync(
      process.execPath,
      [
        "--experimental-strip-types",
        "--no-warnings",
        new URL("./cli.ts", import.meta.url).pathname,
        "--answers",
        join(home, "answers.json"),
      ],
      {
        env: { PATH: process.env.PATH, HOME: home, CLOUDFLARE_API_TOKEN: "test-token" },
        stdio: ["ignore", "pipe", "pipe"],
        encoding: "utf8",
        timeout: 10_000,
      },
    );
    expect(ran.status).toBe(1);
    expect(ran.stderr).toContain("create-gitflare: the input ended before every question");
  });
});
