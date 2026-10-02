import { GitCredentialInput } from "@gitflare/core/api";
import { createFileRoute } from "@tanstack/react-router";
import { forgeApi } from "@/server/api";
import { apiRoute, readJson } from "@/server/http";

// What the `gitflare` credential helper calls each time git needs to
// authenticate against a repository's remote.
export const Route = createFileRoute("/api/git/credentials")({
  server: {
    handlers: {
      POST: apiRoute(async ({ ctx, request }) =>
        forgeApi().repositories.gitCredential(ctx, await readJson(request, GitCredentialInput)),
      ),
    },
  },
});
