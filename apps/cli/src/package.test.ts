import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const nameOf = (path: string) =>
  (JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8")) as { name: string }).name;

describe("the package", () => {
  it("has a name of its own, so `pnpm --filter` picks it and not the workspace root", () => {
    expect(nameOf("../package.json")).not.toBe(nameOf("../../../package.json"));
  });

  it("installs the command as `gitflare`", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { bin: Record<string, string> };
    expect(Object.keys(manifest.bin)).toEqual(["gitflare"]);
  });
});
