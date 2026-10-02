import type { InstallAnswers } from "./answers.ts";

/**
 * One thing the installer does to the account. A plan is the ordered list of
 * them; `--dry-run` prints the plan and stops, which is also how the installer
 * is tested without an account.
 */
export interface InstallStep {
  id: string;
  /** What it does, as the user reads it. */
  title: string;
  /** `check` only looks; `create` makes or updates a resource; `deploy` ships the Worker. */
  kind: "check" | "create" | "deploy";
  /** Looks the resource up by name first, so running the installer twice changes nothing. */
  run(ports: InstallPorts): Promise<StepResult>;
}

export type StepResult =
  | { status: "done"; detail: string; outputs?: Record<string, string> }
  | { status: "unchanged"; detail: string; outputs?: Record<string, string> }
  /** A precondition only the user can meet, in the dashboard. The installer stops here. */
  | { status: "blocked"; detail: string; url: string };

/** Everything the installer reaches outside its own process. Tests supply fakes for all four. */
export interface InstallPorts {
  api: CloudflareApi;
  commands: CommandRunner;
  prompt: Prompter;
  store: AnswerStore;
}

/** The Cloudflare REST API, authenticated. Paths are relative to `/client/v4`. */
export interface CloudflareApi {
  request<T>(method: "GET" | "POST" | "PUT" | "DELETE", path: string, body?: unknown): Promise<T>;
}

/** Runs `wrangler` as a subprocess; tests assert on the arguments instead of deploying. */
export interface CommandRunner {
  run(
    command: string,
    args: string[],
    options?: { cwd?: string; env?: Record<string, string> },
  ): Promise<{ exitCode: number; stdout: string; stderr: string }>;
}

export interface Prompter {
  text(question: string, options?: { default?: string }): Promise<string>;
  select<T extends string>(question: string, choices: { value: T; label: string }[]): Promise<T>;
  confirm(question: string): Promise<boolean>;
  note(message: string): void;
}

export interface AnswerStore {
  load(): Promise<Partial<InstallAnswers> | null>;
  save(answers: InstallAnswers): Promise<void>;
}

/**
 * The steps to install, or upgrade, a deployment with these answers. Pure: it
 * decides nothing by looking at the account, so the same answers always give
 * the same plan. Build task: `installer`.
 */
export function planInstall(_answers: InstallAnswers): InstallStep[] {
  throw new Error("not implemented: planInstall");
}
