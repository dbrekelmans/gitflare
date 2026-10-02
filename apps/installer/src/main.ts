import { parseArgs } from "node:util";
import { formatPlan, runInstall } from "./install.ts";
import type { InstallPorts } from "./plan.ts";
import { planInstall } from "./plan.ts";
import { askAnswers } from "./questions.ts";
import { links } from "./steps.ts";

export const usage = `create-gitflare: installs gitflare into your own Cloudflare account.

  --dry-run          print everything the install would do, and do none of it
  --yes              do not ask before starting
  --answers <file>   where the answers are kept between runs
  --release <dir>    the gitflare release to deploy
  --help

It needs CLOUDFLARE_API_TOKEN: an API token for the account, with Workers
Scripts, D1, Artifacts, AI Gateway and Access (apps and policies; organisations
and identity providers) edit permissions, and Zone read for a custom domain.
Create one at ${links.apiTokens}
`;

export interface Options {
  dryRun: boolean;
  yes: boolean;
  help: boolean;
  answers?: string;
  release?: string;
}

/** Throws on a flag it does not know. */
export function parseOptions(argv: string[]): Options {
  const { values } = parseArgs({
    args: argv,
    options: {
      "dry-run": { type: "boolean", default: false },
      yes: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
      answers: { type: "string" },
      release: { type: "string" },
    },
  });
  return {
    dryRun: values["dry-run"],
    yes: values.yes,
    help: values.help,
    answers: values.answers,
    release: values.release,
  };
}

/** The whole installer, over its ports. Returns the exit code. */
export async function main(
  options: Options,
  ports: InstallPorts,
  env: Record<string, string | undefined>,
): Promise<number> {
  const { prompt } = ports;
  if (options.help) {
    prompt.note(usage);
    return 0;
  }
  if (!options.dryRun && !env.CLOUDFLARE_API_TOKEN) {
    prompt.note(
      `CLOUDFLARE_API_TOKEN is not set. Create an API token and run again:\n  ${links.apiTokens}`,
    );
    return 1;
  }

  const answers = await askAnswers(prompt, await ports.store.load(), {
    accountId: env.CLOUDFLARE_ACCOUNT_ID,
  });
  const steps = planInstall(answers);
  prompt.note(formatPlan(steps));
  if (options.dryRun) {
    prompt.note("Dry run: nothing was looked up, created or saved.");
    return 0;
  }
  if (!options.yes && !(await prompt.confirm("Go ahead?"))) return 1;
  await ports.store.save(answers);

  const outcome = await runInstall(steps, ports);
  if (outcome.blocked) {
    prompt.note(
      `Stopped: ${outcome.blocked.detail}\n  ${outcome.blocked.url}\nThen run create-gitflare again: it carries on from here.`,
    );
    return 1;
  }
  return 0;
}
