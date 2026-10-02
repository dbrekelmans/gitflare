import { ForgeError } from "@gitflare/core";
import { describe, expect, it } from "vitest";
import { agentCommand } from "./agent";

const gatewayBaseUrl = "https://gateway.ai.cloudflare.com/v1/account/gitflare/anthropic";

function build(overrides: Partial<Parameters<typeof agentCommand>[0]> = {}) {
  return agentCommand({
    prompt: "Add an export",
    model: "anthropic/claude-sonnet-5",
    gatewayBaseUrl,
    ...overrides,
  });
}

describe("agentCommand", () => {
  it("runs Claude Code headless, printing one JSON event per line", () => {
    const { command } = build();
    expect(command[0]).toBe("claude");
    expect(command).toContain("--print");
    expect(command.slice(command.indexOf("--output-format"), command.indexOf("--verbose"))).toEqual(
      ["--output-format", "stream-json"],
    );
    expect(command).toContain("--dangerously-skip-permissions");
  });

  it("passes the prompt as one argument that cannot be read as a flag", () => {
    const prompt = '--model other "quoted"; rm -rf /\nsecond line';
    const { command } = build({ prompt });
    expect(command.slice(-2)).toEqual(["--", prompt]);
  });

  it("names the model as the provider-native endpoint does", () => {
    const model = (catalogId: string) => {
      const { command } = build({ model: catalogId });
      return command[command.indexOf("--model") + 1];
    };
    expect(model("anthropic/claude-sonnet-5")).toBe("claude-sonnet-5");
    expect(model("anthropic/claude-haiku-4.5")).toBe("claude-haiku-4-5");
  });

  it("refuses a model Claude Code cannot run", () => {
    expect(() => build({ model: "@cf/meta/llama-4" })).toThrow(ForgeError);
  });

  it("points the agent at the gateway and gives it no credential", () => {
    const { env } = build();
    expect(env.ANTHROPIC_BASE_URL).toBe(gatewayBaseUrl);
    expect(env.ANTHROPIC_API_KEY).toBe("provided-by-gitflare");
    expect(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe("1");
    expect(env.IS_SANDBOX).toBe("1");
    expect(Object.keys(env)).toHaveLength(4);
  });

  it("keeps the conversation, and continues it only when asked", () => {
    expect(build().command).not.toContain("--no-session-persistence");
    expect(build().command).not.toContain("--continue");
    expect(build({ resume: true }).command).toContain("--continue");
  });

  it("refuses a prompt that is empty or too long for one argument", () => {
    expect(() => build({ prompt: "  \n" })).toThrow(/empty/);
    expect(() => build({ prompt: "é".repeat(60_000) })).toThrow(/too long/);
    expect(() => build({ prompt: "e".repeat(60_000) })).not.toThrow();
  });
});
