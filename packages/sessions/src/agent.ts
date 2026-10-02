import { ForgeError } from "@gitflare/core";

/**
 * What the agent is told on top of its own instructions. Nobody is at the
 * terminal, and the turn script pushes the branch itself: an agent that
 * pushed elsewhere, or changed branch, would open a change the session's
 * owner did not ask for.
 */
export const SESSION_INSTRUCTIONS = [
  "You are working in a hosted gitflare session. Nobody is watching the terminal, so do not stop to ask a question: decide, and say what you decided.",
  "The repository is checked out on this session's branch. Commit finished work to that branch with a clear message.",
  "gitflare pushes the branch when your turn ends. Do not push, do not switch branches, and do not rewrite commits that were already pushed.",
].join(" ");

// Linux refuses one argument of 128 KiB or more, and the prompt is one argument.
const MAX_PROMPT_BYTES = 100_000;

const ANTHROPIC_PREFIX = "anthropic/";

/**
 * The agent is Claude Code, which calls the gateway's provider-native
 * Anthropic endpoint. That endpoint takes Anthropic's own model ids, which
 * are the catalog's without the provider and with hyphens for dots
 * (spec/research/ai-identity.md, "Identifier spelling").
 */
function anthropicModel(model: string): string {
  if (model.startsWith(ANTHROPIC_PREFIX)) {
    return model.slice(ANTHROPIC_PREFIX.length).replaceAll(".", "-");
  }
  if (model.includes("/")) {
    throw new ForgeError(
      "invalid",
      `A hosted session runs Claude Code, which needs an Anthropic model; ${model} is not one.`,
    );
  }
  return model;
}

/**
 * The command line and environment the agent is started with for one prompt.
 * `model` is the organisation's `session` model, an AI Gateway catalog id.
 * With `resume`, the turn continues the conversation the previous turn left in
 * this checkout instead of starting a new one.
 *
 * Flags and variables are the Sandbox coding-agent guide's
 * (spec/research/sandbox-ci.md, "Running a coding agent in a Sandbox"), less
 * `--no-session-persistence`, which would make every prompt a stranger to the
 * last. The API key is a placeholder Claude Code will not start without: the
 * gateway's authorisation is added outside the sandbox.
 */
export function agentCommand(input: {
  prompt: string;
  model: string;
  gatewayBaseUrl: string;
  resume?: boolean;
}): {
  command: string[];
  env: Record<string, string>;
} {
  if (input.prompt.trim() === "") {
    throw new ForgeError("invalid", "A prompt cannot be empty.");
  }
  if (new TextEncoder().encode(input.prompt).length > MAX_PROMPT_BYTES) {
    throw new ForgeError("invalid", "The prompt is too long: keep it under 100,000 bytes.");
  }
  return {
    command: [
      "claude",
      "--print",
      "--output-format",
      "stream-json",
      "--verbose",
      "--dangerously-skip-permissions",
      "--model",
      anthropicModel(input.model),
      "--append-system-prompt",
      SESSION_INSTRUCTIONS,
      ...(input.resume ? ["--continue"] : []),
      "--",
      input.prompt,
    ],
    env: {
      ANTHROPIC_BASE_URL: input.gatewayBaseUrl,
      ANTHROPIC_API_KEY: "provided-by-gitflare",
      // No update checks, telemetry or error reports: only the gateway is granted.
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      // Lets the agent skip permission prompts as root, which every process in a sandbox is.
      IS_SANDBOX: "1",
    },
  };
}
