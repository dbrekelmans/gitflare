import { notImplemented } from "@gitflare/core";
import type { CliContext } from "./context.ts";

export interface Command {
  name: string;
  summary: string;
  usage: string;
  run(ctx: CliContext, args: string[]): Promise<number>;
}

// Each command returns the process exit code. Build task: `cli`.
// What each one talks to is in `@gitflare/core/api` (`httpRoutes`) and
// spec/architecture.md, "Git topology" and "Identity".

export const commands: Command[] = [
  {
    name: "login",
    summary: "Sign in to a gitflare deployment through its Access login.",
    usage: "gitflare login <forge-url>",
    run: async () => notImplemented("gitflare login"),
  },
  {
    name: "credential",
    summary: "Git credential helper. Git runs this; you do not.",
    usage: "gitflare credential <get|store|erase>",
    run: async () => notImplemented("gitflare credential"),
  },
  {
    name: "clone",
    summary: "Clone a repository and set git up to use gitflare's credentials for it.",
    usage: "gitflare clone <forge-url>/<repository> [directory]",
    run: async () => notImplemented("gitflare clone"),
  },
  {
    name: "start",
    summary: "Start a session: fork the repository and point this branch's pushes at the fork.",
    usage: "gitflare start <title>",
    run: async () => notImplemented("gitflare start"),
  },
  {
    name: "capture",
    summary: "Turn session capture on in this clone, so pushes carry how they were made.",
    usage: "gitflare capture enable",
    run: async () => notImplemented("gitflare capture"),
  },
  {
    name: "status",
    summary: "Show who you are signed in as and this clone's session.",
    usage: "gitflare status",
    run: async () => notImplemented("gitflare status"),
  },
];
