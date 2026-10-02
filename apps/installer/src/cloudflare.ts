import type { CloudflareApi } from "./plan.ts";

/** The API answered, and refused. `status` is the HTTP status. */
export class CloudflareApiError extends Error {
  readonly status: number;
  readonly errors: { code: number; message: string }[];

  constructor(status: number, errors: { code: number; message: string }[] = []) {
    super(errors.map((e) => `${e.code}: ${e.message}`).join("; ") || `HTTP ${status}`);
    this.name = "CloudflareApiError";
    this.status = status;
    this.errors = errors;
  }
}

/** A `GET` for something that may not exist yet: `null` instead of a `404`. */
export async function lookup<T>(api: CloudflareApi, path: string): Promise<T | null> {
  try {
    return await api.request<T>("GET", path);
  } catch (error) {
    if (error instanceof CloudflareApiError && error.status === 404) return null;
    throw error;
  }
}

interface Envelope {
  success?: boolean;
  result?: unknown;
  errors?: { code: number; message: string }[];
}

export function createCloudflareApi(options: {
  token: string;
  fetch: typeof fetch;
  /** `CLOUDFLARE_API_BASE_URL`, which Wrangler honours too. */
  baseUrl?: string;
}): CloudflareApi {
  const base = options.baseUrl ?? "https://api.cloudflare.com/client/v4";
  return {
    async request<T>(method: string, path: string, body?: unknown): Promise<T> {
      const response = await options.fetch(`${base}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${options.token}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const envelope = (await response.json().catch(() => null)) as Envelope | null;
      if (!response.ok || !envelope?.success) {
        throw new CloudflareApiError(response.status, envelope?.errors ?? []);
      }
      return envelope.result as T;
    },
  };
}
