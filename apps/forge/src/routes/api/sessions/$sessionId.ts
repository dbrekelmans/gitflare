import { SessionRef } from "@gitflare/core/api";
import { createFileRoute } from "@tanstack/react-router";
import { forgeApi } from "@/server/api";
import { apiRoute, parseInput } from "@/server/http";

// `gitflare start` polls this until the session's fork is ready, and
// `gitflare status` reads it.
export const Route = createFileRoute("/api/sessions/$sessionId")({
  server: {
    handlers: {
      GET: apiRoute<{ sessionId: string }>(({ ctx, params }) =>
        forgeApi().sessions.get(ctx, parseInput(SessionRef, params)),
      ),
    },
  },
});
