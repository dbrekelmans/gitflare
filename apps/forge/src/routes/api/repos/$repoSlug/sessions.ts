import { StartSessionInput } from "@gitflare/core/api";
import { createFileRoute } from "@tanstack/react-router";
import { forgeApi } from "@/server/api";
import { apiRoute, parseInput } from "@/server/http";

// `gitflare start` calls this to fork the repository for a new local session.
export const Route = createFileRoute("/api/repos/$repoSlug/sessions")({
  server: {
    handlers: {
      POST: apiRoute<{ repoSlug: string }>(async ({ ctx, request, params }) => {
        const body: unknown = await request.json().catch(() => ({}));
        const input = parseInput(StartSessionInput, {
          ...(body as object),
          repoSlug: params.repoSlug,
        });
        return forgeApi().sessions.start(ctx, input);
      }),
    },
  },
});
