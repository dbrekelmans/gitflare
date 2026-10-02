import { idSchema } from "@gitflare/core/api";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { decisionQueries } from "@/data/decisions.queries";
import { DecisionPage } from "./-components/decision-page";

const decisionId = idSchema("decision");

export const Route = createFileRoute("/decisions/$decisionId")({
  params: {
    parse: (params) => {
      const parsed = decisionId.safeParse(params.decisionId);
      if (!parsed.success) throw notFound();
      return { decisionId: parsed.data };
    },
  },
  loader: ({ context, params }) =>
    context.queryClient.ensureQueryData(decisionQueries.detail(params.decisionId)),
  component: () => <DecisionPage decisionId={Route.useParams().decisionId} />,
});
