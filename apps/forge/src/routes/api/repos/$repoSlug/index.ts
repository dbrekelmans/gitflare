import { RepoRef } from "@gitflare/core/api";
import { createFileRoute } from "@tanstack/react-router";
import { forgeApi } from "@/server/api";
import { apiRoute, parseInput } from "@/server/http";

export const Route = createFileRoute("/api/repos/$repoSlug/")({
  server: {
    handlers: {
      GET: apiRoute<{ repoSlug: string }>(({ ctx, params }) =>
        forgeApi().repositories.get(ctx, parseInput(RepoRef, params)),
      ),
    },
  },
});
