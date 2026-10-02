import { capture } from "./commands/capture.ts";
import { clone } from "./commands/clone.ts";
import { credential } from "./commands/credential.ts";
import { login } from "./commands/login.ts";
import { logout } from "./commands/logout.ts";
import { start } from "./commands/start.ts";
import { status } from "./commands/status.ts";
import type { CliContext } from "./context.ts";

export interface Command {
  name: string;
  summary: string;
  usage: string;
  run(ctx: CliContext, args: string[]): Promise<number>;
}

// Each command returns the process exit code. What each one talks to is in
// `@gitflare/core/api` (`httpRoutes`) and spec/architecture.md, "Git topology"
// and "Identity".

export const commands: Command[] = [
  {
    name: "login",
    summary: "Sign in to a gitflare deployment through its Access login.",
    usage: "gitflare login [--cloudflared] <forge-url>",
    run: login,
  },
  {
    name: "logout",
    summary: "Forget the login for a gitflare deployment.",
    usage: "gitflare logout [forge-url]",
    run: logout,
  },
  {
    name: "credential",
    summary: "Git credential helper. Git runs this; you do not.",
    usage: "gitflare credential <get|store|erase>",
    run: credential,
  },
  {
    name: "clone",
    summary: "Clone a repository and set git up to use gitflare's credentials for it.",
    usage: "gitflare clone <forge-url>/<repository> [directory]",
    run: clone,
  },
  {
    name: "start",
    summary: "Start a session: fork the repository and point this branch's pushes at the fork.",
    usage: "gitflare start <title>",
    run: start,
  },
  {
    name: "capture",
    summary: "Turn session capture on in this clone, so pushes carry how they were made.",
    usage: "gitflare capture enable",
    run: capture,
  },
  {
    name: "status",
    summary: "Show who you are signed in as and this clone's session.",
    usage: "gitflare status",
    run: status,
  },
];
