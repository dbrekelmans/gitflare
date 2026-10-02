import { idSchema } from "@gitflare/core/api";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { accountQueries } from "@/data/account.queries";
import { sessionQueries } from "@/data/sessions.queries";
import { SessionPage } from "./-components/session-page";

const sessionId = idSchema("session");

export const Route = createFileRoute("/sessions/$sessionId")({
  params: {
    parse: (params) => {
      const parsed = sessionId.safeParse(params.sessionId);
      if (!parsed.success) throw notFound();
      return { sessionId: parsed.data };
    },
  },
  loader: async ({ context, params }) => {
    await Promise.all([
      context.queryClient.ensureQueryData(sessionQueries.detail(params.sessionId)),
      context.queryClient.ensureQueryData(sessionQueries.events(params.sessionId)),
      context.queryClient.ensureQueryData(accountQueries.me()),
    ]);
  },
  component: () => <SessionPage sessionId={Route.useParams().sessionId} />,
});
