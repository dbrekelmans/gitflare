import { ForgeError } from "@gitflare/core";
import { StartSessionInput } from "@gitflare/core/api";
import { createFileRoute } from "@tanstack/react-router";
import { forgeApi } from "@/server/api";
import { apiRoute } from "@/server/http";

// `gitflare start` calls this to fork the repository for a new local session.
export const Route = createFileRoute("/api/repos/$repoSlug/sessions")({
  server: {
    handlers: {
      POST: apiRoute<{ repoSlug: string }>(async ({ ctx, request, params }) => {
        const body: unknown = await request.json().catch(() => ({}));
        const input = StartSessionInput.safeParse({
          ...(body as object),
          repoSlug: params.repoSlug,
        });
        if (!input.success) throw new ForgeError("invalid", input.error.message);
        return forgeApi().sessions.start(ctx, input.data);
      }),
    },
  },
});
