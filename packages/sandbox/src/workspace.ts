import { ForgeError } from "@gitflare/core";
import type {
  IdGenerator,
  ProcessStatus,
  SandboxHost,
  SandboxInstance,
  SandboxSnapshot,
} from "@gitflare/core/ports";

const SETUP_PROCESS = "setup";
const SETUP_PATH = "/tmp/gitflare-setup.sh";
/** How much of the script's output a failure quotes. */
const TAIL_CHARACTERS = 2_000;

export interface PrepareWorkspaceOptions {
  instance?: SandboxInstance;
  /** The script is killed after this long. Keep it under the calling Workflow step's own timeout. */
  timeoutSeconds?: number;
  pollMs?: number;
}

/**
 * The provisioning Workflow's workspace step: boots the managed base image
 * with Internet access, runs `setupScript` (the text of
 * `containers/workspace/setup.sh`), takes a snapshot and stops the container.
 * The caller stores the result in the organisation's `workspace` settings.
 *
 * Each call uses a sandbox of its own, so a retry never meets the container a
 * failed attempt left behind. A failed script throws with the end of its
 * output.
 */
export async function prepareWorkspace(
  deps: { sandboxes: SandboxHost; ids: IdGenerator },
  input: { image: string; setupScript: string },
  options: PrepareWorkspaceOptions = {},
): Promise<SandboxSnapshot> {
  const { instance = "standard-1", timeoutSeconds = 540, pollMs = 2_000 } = options;
  const sandbox = deps.sandboxes.get(deps.ids.next("sandbox"));
  await sandbox.start({ image: input.image, instance, egress: [{ kind: "host", host: "*" }] });
  try {
    await sandbox.writeFile(SETUP_PATH, input.setupScript);
    // The script runs for minutes: in the background, so that it does not
    // depend on one request staying open.
    await sandbox.spawn(SETUP_PROCESS, ["sh", SETUP_PATH], { cwd: "/", timeoutSeconds });

    let status: ProcessStatus | null = await sandbox.processStatus(SETUP_PROCESS);
    while (status?.state === "running") {
      await new Promise((resolve) => setTimeout(resolve, pollMs));
      status = await sandbox.processStatus(SETUP_PROCESS);
    }
    if (status?.exitCode !== 0) {
      const { text } = await sandbox.readLog(SETUP_PROCESS, "stderr", 0);
      const reason = status ? `exit code ${status.exitCode}` : "the script never started";
      throw new ForgeError(
        "unavailable",
        `Preparing the workspace failed (${reason}): ${text.slice(-TAIL_CHARACTERS).trim()}`,
      );
    }
    await sandbox.exec(["rm", "-f", SETUP_PATH]);
    return await sandbox.snapshot();
  } finally {
    await sandbox.stop();
  }
}
