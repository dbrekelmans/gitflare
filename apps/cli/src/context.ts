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
  exec: (command: string, args: string[], options?: ExecOptions) => Promise<ExecOutput>;
  /** Where the login's refresh token is kept: the OS keychain in the real CLI. */
  secrets: SecretStore;
  /** Opens a URL in the user's browser. */
  openBrowser: (url: string) => Promise<void>;
  /** Listens on the loopback interface for the browser coming back from a login. */
  listenForRedirect: () => Promise<RedirectListener>;
  /** Milliseconds since the Unix epoch. */
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

export interface ExecOptions {
  cwd?: string;
  input?: string;
  /**
   * Lets the program write its progress straight to the terminal instead of
   * having it collected: `stderr` in the output is then empty.
   */
  showProgress?: boolean;
}

export interface ExecOutput {
  /** 127 when the program is not installed. */
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface SecretStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface RedirectListener {
  /** The `redirect_uri` to register and to send with the authorisation request. */
  redirectUri: string;
  /** The query the browser arrived with. */
  wait(): Promise<URLSearchParams>;
  close(): Promise<void>;
}

/** A failure the user can act on: printed as its message, with no stack. */
export class CliError extends Error {
  constructor(
    message: string,
    /** The forge's error code, when the forge is what refused. */
    readonly code?: string,
  ) {
    super(message);
    this.name = "CliError";
  }
}

/** The arguments do not fit the command: answered with its usage line. */
export class UsageError extends Error {
  constructor() {
    super("wrong arguments");
    this.name = "UsageError";
  }
}
