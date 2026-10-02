/**
 * Thrown by every stub in the scaffold. The forge treats it specially in local
 * development: an API operation that is not built yet falls back to fixture
 * data instead of failing the page.
 */
export class NotImplementedError extends Error {
  constructor(what: string) {
    super(`not implemented: ${what}`);
    this.name = "NotImplementedError";
  }
}

export function notImplemented(what: string): never {
  throw new NotImplementedError(what);
}

export const errorCodes = [
  "unauthenticated",
  "forbidden",
  "not_found",
  "conflict",
  "invalid",
  "not_ready",
  "budget_exceeded",
  "unavailable",
] as const;
export type ErrorCode = (typeof errorCodes)[number];

/**
 * An expected failure with a code a caller can act on. Server functions let it
 * propagate; server routes map it to a status with `httpStatus`.
 */
export class ForgeError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ForgeError";
  }
}

export function httpStatus(code: ErrorCode): number {
  switch (code) {
    case "unauthenticated":
      return 401;
    case "forbidden":
      return 403;
    case "not_found":
      return 404;
    case "conflict":
    case "not_ready":
      return 409;
    case "invalid":
      return 422;
    case "budget_exceeded":
      return 429;
    case "unavailable":
      return 503;
  }
}
