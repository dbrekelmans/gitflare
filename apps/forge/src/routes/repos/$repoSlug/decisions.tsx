import { Row } from "@gitflare/ui/components/row";
import { StatusPill } from "@gitflare/ui/components/status";
import { Evidence } from "@gitflare/ui/components/typography";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { RouteLink } from "@/components/shell/link";
import { PageHead, Unbuilt } from "@/components/shell/page";
import { decisionQueries } from "@/data/decisions.queries";

export const Route = createFileRoute("/repos/$repoSlug/decisions")({
  loader: ({ context, params }) =>
    context.queryClient.ensureQueryData(decisionQueries.list(params.repoSlug)),
  component: Decisions,
});

function Decisions() {
  const { repoSlug } = Route.useParams();
  const { data } = useSuspenseQuery(decisionQueries.list(repoSlug));
  return (
    <>
      <PageHead
        title="Decisions"
        lede={`What ${repoSlug} has decided about how it is built, recorded from its reviews. Reviews are given the ones that apply.`}
      />
      {data.map((decision) => (
        <Row
          key={decision.id}
          label={
            <RouteLink to="/decisions/$decisionId" params={{ decisionId: decision.id }}>
              {decision.title}
            </RouteLink>
          }
          annotation={
            <Evidence size="sm" kind="note">
              strength {decision.strength.toFixed(2)}
            </Evidence>
          }
        >
          {decision.statement}
          {decision.status === "dormant" && (
            <StatusPill tone="neutral" className="ml-s4">
              dormant
            </StatusPill>
          )}
        </Row>
      ))}
      <Unbuilt task="web-decisions" />
    </>
  );
}
