import { WorkerEntrypoint } from "cloudflare:workers";
import { mintSystemToken } from "@gitflare/artifacts";
import { attributionMetadata } from "@gitflare/models";
import {
  createGitTokenCache,
  type EgressDeps,
  type EgressProps,
  forwardEgress,
} from "@gitflare/sandbox";
import { getServices } from "./services";

let deps: EgressDeps | undefined;

/** Built once per isolate, so that a token minted for one request serves the next. */
function egressDeps(env: Env): EgressDeps {
  if (deps) return deps;
  const services = getServices();
  deps = {
    gitToken: createGitTokenCache({
      clock: services.clock,
      mint: async (repo, scope) => {
        const { secret, grant } = await mintSystemToken(services, repo, scope, "sandbox");
        return { secret, expiresAt: grant.expiresAt };
      },
    }),
    // The Worker's AI binding is the gateway authorisation: no gateway token exists.
    models: ({ provider, endpoint, headers, body, attribution }) => {
      const gateway = {
        id: env.AI_GATEWAY_ID,
        metadata: attributionMetadata(attribution),
        skipCache: true,
      };
      return env.AI.gateway(gateway.id).run(
        { provider, endpoint, headers, query: body },
        { gateway },
      );
    },
    fetch: (request) => fetch(request),
  };
  return deps;
}

/**
 * Where a sandbox's outbound HTTPS arrives. The sandbox registers this
 * entrypoint as its intercept, with its egress grants as props; each request
 * is checked with `decideEgress` from `@gitflare/sandbox`, given the
 * credential the grant calls for, and forwarded. No token ever enters a
 * container. Build task: `sandbox`.
 */
export class SandboxEgress extends WorkerEntrypoint<Env, EgressProps> {
  async fetch(request: Request): Promise<Response> {
    return forwardEgress(egressDeps(this.env), this.ctx.props, request);
  }
}
