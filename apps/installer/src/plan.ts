import type { InstallAnswers } from "./answers.ts";
import {
  accessApplication,
  artifactsAvailable,
  artifactsNamespace,
  database,
  deployConfig,
  deployWorker,
  gateway,
  hostname,
  migrations,
  modelBilling,
  oneTimePin,
  prepareWorkspace,
  spendRule,
  zeroTrust,
} from "./steps.ts";

/**
 * One thing the installer does to the account. A plan is the ordered list of
 * them; `--dry-run` prints the plan and stops, which is also how the installer
 * is tested without an account.
 */
export interface InstallStep {
  id: string;
  /** What it does, as the user reads it. */
  title: string;
  /**
   * `check` only looks; `create` makes or updates a resource; `deploy` ships
   * the Worker; `manual` is something only the administrator can do, afterwards.
   */
  kind: "check" | "create" | "deploy" | "manual";
  /**
   * Looks the resource up by name first, so running the installer twice changes
   * nothing. `outputs` is what the steps before this one reported.
   */
  run(ports: InstallPorts, outputs: StepOutputs): Promise<StepResult>;
}

export type StepOutputs = Readonly<Record<string, string>>;

export type StepResult =
  | { status: "done"; detail: string; outputs?: Record<string, string> }
  | { status: "unchanged"; detail: string; outputs?: Record<string, string> }
  /** A precondition only the user can meet, in the dashboard. The installer stops here. */
  | { status: "blocked"; detail: string; url: string };

/** Everything the installer reaches outside its own process. Tests supply fakes for all five. */
export interface InstallPorts {
  api: CloudflareApi;
  commands: CommandRunner;
  prompt: Prompter;
  store: AnswerStore;
  files: ReleaseFiles;
}

/**
 * The Cloudflare REST API, authenticated. Paths are relative to `/client/v4`.
 * Resolves to the envelope's `result`; a refusal throws `CloudflareApiError`.
 */
export interface CloudflareApi {
  request<T>(method: "GET" | "POST" | "PUT" | "DELETE", path: string, body?: unknown): Promise<T>;
}

/**
 * Runs `wrangler` as a subprocess, in the release directory unless told
 * otherwise; tests assert on the arguments instead of deploying.
 */
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

/** The release being installed: the forge's directory. Names are relative to it. */
export interface ReleaseFiles {
  read(name: string): Promise<string | null>;
  write(name: string, text: string): Promise<void>;
}

/**
 * The steps to install, or upgrade, a deployment with these answers. Pure: it
 * decides nothing by looking at the account, so the same answers always give
 * the same plan.
 */
export function planInstall(answers: InstallAnswers): InstallStep[] {
  return [
    // Preconditions first, so a missing one stops before anything is created.
    artifactsAvailable(answers),
    zeroTrust(answers),
    hostname(answers),
    // The gateway before the billing check: a stored provider key belongs to a gateway.
    gateway(answers),
    spendRule(answers),
    modelBilling(answers),
    artifactsNamespace(answers),
    database(answers),
    oneTimePin(answers),
    // Access before the deploy: the forge is never reachable unprotected.
    accessApplication(answers),
    deployConfig(answers),
    migrations(answers),
    deployWorker(answers),
    prepareWorkspace(answers),
  ];
}
