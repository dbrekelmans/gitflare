import { createFileRoute } from "@tanstack/react-router";
import { forgeApi } from "@/server/api";
import { apiRoute } from "@/server/http";

export const Route = createFileRoute("/api/me")({
  server: {
    handlers: {
      GET: apiRoute(({ ctx }) => forgeApi().account.me(ctx)),
    },
  },
});
