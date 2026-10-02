/**
 * Everything a command touches outside its arguments, so commands can be
 * tested without a terminal, a network, a keychain or a git repository.
 */
export interface CliContext {
  stdin: () => Promise<string>;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  env: Record<string, string | undefined>;
  cwd: string;
  /** HTTP to the forge and to its Access login. */
  fetch: typeof fetch;
  /** Runs a program and returns what it printed. Used for `git` and `entire`. */
  exec: (
    command: string,
    args: string[],
    options?: { cwd?: string; input?: string },
  ) => Promise<ExecOutput>;
  /** Where the login's refresh token is kept: the OS keychain in the real CLI. */
  secrets: SecretStore;
  /** Opens a URL in the user's browser. */
  openBrowser: (url: string) => Promise<void>;
}

export interface ExecOutput {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface SecretStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}
