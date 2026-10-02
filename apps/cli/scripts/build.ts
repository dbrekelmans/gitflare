import { chmod } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = resolve(fileURLToPath(import.meta.url), "../..");

/** Bundles the CLI and everything it imports into one file that plain `node` runs. */
export async function buildCli(
  outfile: string = resolve(root, "dist/gitflare.js"),
): Promise<string> {
  await build({
    entryPoints: [resolve(root, "src/cli.ts")],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    logLevel: "warning",
  });
  await chmod(outfile, 0o755);
  return outfile;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await buildCli();
