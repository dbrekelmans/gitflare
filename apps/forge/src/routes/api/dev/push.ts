import { ForgeError, type Push } from "@gitflare/core";
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { forgeApi } from "@/server/api";
import { apiRoute, readJson } from "@/server/http";
import { getServices } from "@/server/services";

const PushBody = z.object({
  repoName: z.string(),
  ref: z.string(),
  before: z.string(),
  after: z.string(),
}) satisfies z.ZodType<Push>;

// Local development only: raises a push as if Artifacts had sent the event,
// so the pipeline can be exercised without a git host.
export const Route = createFileRoute("/api/dev/push")({
  server: {
    handlers: {
      POST: apiRoute(async ({ ctx, request }) => {
        if (getServices().mode !== "dev") throw new ForgeError("not_found", "Not found.");
        await forgeApi().dev.simulatePush(ctx, await readJson(request, PushBody));
      }),
    },
  },
});
