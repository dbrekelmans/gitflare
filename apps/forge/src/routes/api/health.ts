import { env } from "cloudflare:workers";
import type { HealthResponse } from "@gitflare/core/api";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/health")({
  server: {
    handlers: {
      GET: () => {
        const body: HealthResponse = {
          ok: true,
          mode: env.GITFLARE_MODE === "dev" ? "dev" : "production",
        };
        return Response.json(body);
      },
    },
  },
});
