import { WorkerEntrypoint } from "cloudflare:workers";

/**
 * Where a sandbox's outbound HTTP and HTTPS arrives. The sandbox registers
 * this entrypoint as its intercept, with its egress grants as props; each
 * request is checked with `decideEgress` from `@gitflare/sandbox`, given the
 * credential the grant calls for, and forwarded. No token ever enters a
 * container. Build task: `sandbox`.
 */
export class SandboxEgress extends WorkerEntrypoint<Env> {
  async fetch(_request: Request): Promise<Response> {
    return new Response("not implemented: SandboxEgress.fetch", { status: 501 });
  }
}
