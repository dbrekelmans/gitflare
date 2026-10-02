import { describe, expect, it } from "vitest";
import type { CliContext } from "./context.ts";
import { run, usage } from "./run.ts";

function context() {
  const out: string[] = [];
  const err: string[] = [];
  const ctx = {
    stdout: (text: string) => void out.push(text),
    stderr: (text: string) => void err.push(text),
  } as unknown as CliContext;
  return { ctx, out, err };
}

describe("gitflare", () => {
  it("prints usage naming every command", async () => {
    const { ctx, out } = context();
    expect(await run(ctx, ["help"])).toBe(0);
    for (const name of ["login", "credential", "clone", "start", "capture", "status"]) {
      expect(out.join("")).toContain(name);
    }
    expect(usage()).toBe(out.join(""));
  });

  it("fails without a command, and on one it does not know", async () => {
    expect(await run(context().ctx, [])).toBe(1);
    const { ctx, err } = context();
    expect(await run(ctx, ["nope"])).toBe(1);
    expect(err.join("")).toContain('unknown command "nope"');
  });

  it("reports a failing command instead of throwing", async () => {
    const { ctx, err } = context();
    ctx.exec = async () => {
      throw new Error("git went away");
    };
    expect(await run(ctx, ["status"])).toBe(1);
    expect(err.join("")).toBe("gitflare status: git went away\n");
  });
});
