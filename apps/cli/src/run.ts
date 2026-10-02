import { commands } from "./commands.ts";
import { type CliContext, UsageError } from "./context.ts";

export function usage(): string {
  const width = Math.max(...commands.map((command) => command.name.length));
  return [
    "Usage: gitflare <command> [arguments]",
    "",
    ...commands.map((command) => `  ${command.name.padEnd(width)}  ${command.summary}`),
    "",
  ].join("\n");
}

/** Dispatches to a command and turns anything it throws into a message and a non-zero exit code. */
export async function run(ctx: CliContext, argv: string[]): Promise<number> {
  const [name, ...args] = argv;
  if (!name || name === "help" || name === "--help" || name === "-h") {
    ctx.stdout(usage());
    return name ? 0 : 1;
  }
  const command = commands.find((candidate) => candidate.name === name);
  if (!command) {
    ctx.stderr(`gitflare: unknown command "${name}"\n\n${usage()}`);
    return 1;
  }
  try {
    return await command.run(ctx, args);
  } catch (error) {
    if (error instanceof UsageError) {
      ctx.stderr(`Usage: ${command.usage}\n`);
      return 1;
    }
    ctx.stderr(`gitflare ${name}: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
