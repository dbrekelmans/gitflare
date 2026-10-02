import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname } from "node:path";
import {
  type CliContext,
  CliError,
  type ExecOptions,
  type ExecOutput,
  type RedirectListener,
  type SecretStore,
} from "./context.ts";

// The real context: process streams, the network, child processes, the OS
// keychain and a loopback listener. Nothing here decides anything.

type Exec = CliContext["exec"];

/** How long a person gets to finish signing in in the browser. */
const LOGIN_TIMEOUT_MS = 5 * 60_000;
const KEYCHAIN_SERVICE = "gitflare";

export const exec: Exec = (command, args, options: ExecOptions = {}) =>
  new Promise<ExecOutput>((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: [
        options.input === undefined ? "ignore" : "pipe",
        "pipe",
        options.showProgress ? "inherit" : "pipe",
      ],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      resolve({
        exitCode: error.code === "ENOENT" ? 127 : 126,
        stdout,
        stderr: `${command}: ${error.message}`,
      });
    });
    child.on("close", (code) => resolve({ exitCode: code ?? 1, stdout, stderr }));
    // A program that exits without reading its input is not an error here.
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(options.input);
  });

// A secret is stored hex-encoded so it needs no quoting on any of these paths.
const encode = (value: string) => Buffer.from(value, "utf8").toString("hex");
const decode = (stored: string) => Buffer.from(stored.trim(), "hex").toString("utf8");

/**
 * The macOS keychain, through `security`. A secret is written through
 * `security -i`, which reads its command from standard input, so that it
 * never appears in a process's arguments.
 */
function macKeychain(run: Exec): SecretStore {
  return {
    async get(key) {
      const found = await run("security", [
        "find-generic-password",
        "-s",
        KEYCHAIN_SERVICE,
        "-a",
        key,
        "-w",
      ]);
      return found.exitCode === 0 ? decode(found.stdout) : null;
    },
    async set(key, value) {
      const command = `add-generic-password -U -s ${KEYCHAIN_SERVICE} -a "${key}" -w ${encode(value)}\n`;
      const stored = await run("security", ["-i"], { input: command });
      if (stored.exitCode !== 0) {
        throw new CliError(`The keychain refused the login. ${stored.stderr.trim()}`.trim());
      }
    },
    async delete(key) {
      await run("security", ["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", key]);
    },
  };
}

/** The Secret Service on Linux (GNOME Keyring, KWallet), through `secret-tool`. */
function secretService(run: Exec): SecretStore {
  const attributes = (key: string) => ["service", KEYCHAIN_SERVICE, "account", key];
  return {
    async get(key) {
      const found = await run("secret-tool", ["lookup", ...attributes(key)]);
      return found.exitCode === 0 && found.stdout.trim() ? decode(found.stdout) : null;
    },
    async set(key, value) {
      const stored = await run(
        "secret-tool",
        ["store", `--label=gitflare ${key}`, ...attributes(key)],
        { input: encode(value) },
      );
      if (stored.exitCode !== 0) {
        throw new CliError(
          "No keychain is available to hold the login (secret-tool failed). " +
            "Set GITFLARE_SECRETS_FILE to keep it in a file readable only by you.",
        );
      }
    },
    async delete(key) {
      await run("secret-tool", ["clear", ...attributes(key)]);
    },
  };
}

/** A file only its owner can read. For machines with no keychain; chosen explicitly. */
function secretsFile(path: string): SecretStore {
  const read = async (): Promise<Record<string, string>> => {
    try {
      return JSON.parse(await readFile(path, "utf8")) as Record<string, string>;
    } catch {
      return {};
    }
  };
  const write = async (secrets: Record<string, string>) => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(secrets), { mode: 0o600 });
    await chmod(path, 0o600);
  };
  return {
    get: async (key) => (await read())[key] ?? null,
    set: async (key, value) => write({ ...(await read()), [key]: value }),
    async delete(key) {
      const { [key]: _removed, ...rest } = await read();
      await write(rest);
    },
  };
}

export function createSecretStore(
  platform: NodeJS.Platform,
  env: Record<string, string | undefined>,
  run: Exec = exec,
): SecretStore {
  if (env.GITFLARE_SECRETS_FILE) return secretsFile(env.GITFLARE_SECRETS_FILE);
  if (platform === "darwin") return macKeychain(run);
  if (platform === "linux") return secretService(run);
  const unsupported = async (): Promise<never> => {
    throw new CliError(
      `gitflare cannot use this platform's keychain yet (${platform}). ` +
        "Set GITFLARE_SECRETS_FILE to keep the login in a file readable only by you.",
    );
  };
  return { get: async () => null, set: unsupported, delete: unsupported };
}

async function openBrowser(url: string): Promise<void> {
  const [command, ...args] =
    process.platform === "darwin"
      ? ["open", url]
      : process.platform === "win32"
        ? ["rundll32", "url.dll,FileProtocolHandler", url]
        : ["xdg-open", url];
  const opened = await exec(command as string, args);
  if (opened.exitCode !== 0) throw new Error(opened.stderr);
}

/** One request to `http://127.0.0.1:<port>/callback`, on a port the system picks. */
export async function listenForRedirect(
  timeoutMs: number = LOGIN_TIMEOUT_MS,
): Promise<RedirectListener> {
  let settle: (query: URLSearchParams) => void = () => undefined;
  const arrived = new Promise<URLSearchParams>((resolve) => {
    settle = resolve;
  });
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/callback") {
      response.writeHead(404).end();
      return;
    }
    response
      .writeHead(200, { "content-type": "text/html; charset=utf-8", connection: "close" })
      .end(
        "<!doctype html><title>gitflare</title><p>You can close this tab and go back to the terminal.</p>",
      );
    settle(url.searchParams);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  let timer: NodeJS.Timeout | undefined;
  return {
    redirectUri: `http://127.0.0.1:${port}/callback`,
    wait: () =>
      Promise.race([
        arrived,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new CliError("Nobody finished signing in in the browser. Try again.")),
            timeoutMs,
          );
        }),
      ]),
    close: () =>
      new Promise<void>((resolve) => {
        clearTimeout(timer);
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

export function createSystemContext(): CliContext {
  return {
    stdin: async () => {
      let text = "";
      for await (const chunk of process.stdin) text += chunk;
      return text;
    },
    stdout: (text) => void process.stdout.write(text),
    stderr: (text) => void process.stderr.write(text),
    env: process.env,
    cwd: process.cwd(),
    fetch,
    exec,
    secrets: createSecretStore(process.platform, process.env),
    openBrowser,
    listenForRedirect: () => listenForRedirect(),
    now: Date.now,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}
