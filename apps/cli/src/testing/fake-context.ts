import type { User } from "@gitflare/core";
import { demo } from "@gitflare/testing/demo";
import type { CliContext, ExecOptions, ExecOutput } from "../context.ts";
import { FakeForge } from "./fake-forge.ts";
import { FakeGit } from "./fake-git.ts";

export interface FakeCli {
  ctx: CliContext;
  forge: FakeForge;
  git: FakeGit;
  secrets: Map<string, string>;
  /** Everything written to standard output, and to standard error. */
  out: () => string;
  err: () => string;
  /** Forgets what has been printed so far. */
  clear: () => void;
  /** What the next command reads from standard input. */
  stdin: (text: string) => void;
  /** Programs other than git: what running one does. Unlisted ones are not installed. */
  programs: Map<string, (args: string[], options: ExecOptions) => ExecOutput>;
  /** Every program run, as one line each. */
  ran: string[];
  /** Every URL the browser was sent to. */
  opened: string[];
  /** Moves the clock without anything happening. */
  advance: (ms: number) => void;
  slept: number[];
}

/**
 * A `CliContext` with nothing real in it: a fake deployment for the network,
 * a fake git for `exec`, a map for the keychain, a clock that moves only when
 * a command sleeps, and a browser that goes straight through the login.
 */
export function createFakeCli(options: { user?: User; cwd?: string } = {}): FakeCli {
  let now = demo.now;
  let input = "";
  const out: string[] = [];
  const err: string[] = [];
  const secrets = new Map<string, string>();
  const git = new FakeGit();
  const forge = new FakeForge(options.user ?? demo.viewer, () => now);
  const programs: FakeCli["programs"] = new Map();
  const ran: string[] = [];
  const opened: string[] = [];
  const slept: number[] = [];
  let arrive: (query: URLSearchParams) => void = () => undefined;

  const ctx: CliContext = {
    stdin: async () => input,
    stdout: (text) => void out.push(text),
    stderr: (text) => void err.push(text),
    env: {},
    cwd: options.cwd ?? "/work",
    fetch: forge.fetch,
    exec: async (command, args, execOptions = {}) => {
      ran.push([command, ...args].join(" "));
      if (command === "git") return git.exec(args, execOptions);
      const program = programs.get(command);
      if (!program) return { exitCode: 127, stdout: "", stderr: `${command}: not found` };
      return program(args, execOptions);
    },
    secrets: {
      get: async (key) => secrets.get(key) ?? null,
      set: async (key, value) => void secrets.set(key, value),
      delete: async (key) => void secrets.delete(key),
    },
    openBrowser: async (url) => {
      opened.push(url);
      arrive(forge.visit(url));
    },
    listenForRedirect: async () => {
      const arrived = new Promise<URLSearchParams>((resolve) => {
        arrive = resolve;
      });
      return {
        redirectUri: "http://127.0.0.1:49152/callback",
        wait: () => arrived,
        close: async () => undefined,
      };
    },
    now: () => now,
    sleep: async (ms) => {
      slept.push(ms);
      now += ms;
    },
  };

  return {
    ctx,
    forge,
    git,
    secrets,
    out: () => out.join(""),
    err: () => err.join(""),
    clear: () => {
      out.length = 0;
      err.length = 0;
    },
    stdin: (text) => {
      input = text;
    },
    programs,
    ran,
    opened,
    advance: (ms) => {
      now += ms;
    },
    slept,
  };
}
