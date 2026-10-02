import { env } from "cloudflare:workers";
import { ChangeRef } from "@gitflare/core/api";
import { createFileRoute } from "@tanstack/react-router";
import { requestContext } from "@/server/context";

// The live connection for one change. The caller is authenticated here, then
// the upgrade is handed to the change's Durable Object, which holds the socket.
export const Route = createFileRoute("/api/changes/$changeId/live")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
          return new Response("Expected a WebSocket upgrade.", { status: 426 });
        }
        const change = ChangeRef.safeParse(params);
        if (!change.success) return new Response("No such change.", { status: 404 });
        try {
          await requestContext(request.headers);
        } catch {
          return new Response("Sign in to continue.", { status: 401 });
        }
        return env.CHANGE_ROOM.getByName(change.data.changeId).fetch(request);
      },
    },
  },
});
