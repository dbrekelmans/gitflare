// The files gitflare commits to a repository so the unmodified Entire CLI
// pushes checkpoints to its context repo. Schema: spec/research/entire-capture.md
// ("Configuration", "Capture mechanics"). `checkpoints.primary.type` is always
// `git-refs`: it is what lets both checkpoint id shapes (ULID and legacy hex)
// be read the same way, by ref tip, with no legacy branch to fall back to.

/**
 * The files gitflare commits to a repository so the unmodified Entire CLI
 * pushes checkpoints to its context repo: `.entire/settings.json`,
 * `.entire/.gitignore` and the agent hook settings. A clone carrying them
 * needs no `entire enable`. The settings name the provider `artifacts` (never
 * `github` or `gitlab`, which would send tokens to those hosts), use the
 * `git-refs` backend, and set `commit_linking` to `always`.
 */
export function captureSettingsFiles(input: {
  /** The context repo's path on the git host, e.g. `git/<namespace>/<slug>.context`. */
  contextRepoPath: string;
}): Record<string, string> {
  const settings = {
    enabled: true,
    checkpoints: { primary: { type: "git-refs" } },
    commit_linking: "always",
    strategy_options: {
      checkpoint_remote: { provider: "artifacts", repo: input.contextRepoPath },
    },
  };

  // Claude Code is the MVP's one supported agent. Every command exits 0
  // silently on a machine without `entire` on `PATH`, as Entire's own
  // generated hooks do.
  const claudeCodeSettings = {
    hooks: {
      PostToolUse: [
        {
          matcher: "Agent",
          hooks: [
            {
              type: "command",
              command:
                "sh -c 'if ! command -v entire >/dev/null 2>&1; then exit 0; fi; exec entire hooks claude-code post-task'",
            },
          ],
        },
        {
          matcher: "TaskCreate|TaskUpdate",
          hooks: [
            {
              type: "command",
              command:
                "sh -c 'if ! command -v entire >/dev/null 2>&1; then exit 0; fi; exec entire hooks claude-code post-todo'",
            },
          ],
        },
      ],
      SessionStart: [
        {
          matcher: "",
          hooks: [
            {
              type: "command",
              command:
                'sh -c \'if ! command -v entire >/dev/null 2>&1; then printf "%s\\n" "{\\"systemMessage\\":\\"\\\\n\\\\nEntire CLI is enabled but not installed or not on PATH.\\\\nInstallation guide: https://docs.entire.io/cli/installation#installation-methods\\"}"; exit 0; fi; exec entire hooks claude-code session-start\'',
            },
          ],
        },
      ],
      Stop: [
        {
          matcher: "",
          hooks: [
            {
              type: "command",
              command:
                "sh -c 'if ! command -v entire >/dev/null 2>&1; then exit 0; fi; exec entire hooks claude-code stop'",
            },
          ],
        },
      ],
    },
  };

  return {
    ".entire/settings.json": `${JSON.stringify(settings, null, 2)}\n`,
    ".entire/.gitignore": "settings.local.json\n",
    ".claude/settings.json": `${JSON.stringify(claudeCodeSettings, null, 2)}\n`,
  };
}
