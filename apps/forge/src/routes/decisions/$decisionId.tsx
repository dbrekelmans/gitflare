import { idSchema } from "@gitflare/core/api";
import { Row, SectionHead } from "@gitflare/ui/components/row";
import { Evidence } from "@gitflare/ui/components/typography";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { PageHead, Unbuilt } from "@/components/shell/page";
import { decisionQueries } from "@/data/decisions.queries";
import { formatTime } from "@/lib/format";

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
  component: DecisionPage,
});

function DecisionPage() {
  const params = Route.useParams();
  const { data } = useSuspenseQuery(decisionQueries.detail(params.decisionId));
  return (
    <>
      <PageHead
        title={data.decision.title}
        lede={data.decision.statement}
        aside={
          <Evidence size="sm" kind="note">
            {data.decision.status} · strength {data.decision.strength.toFixed(2)}
          </Evidence>
        }
      />
      <SectionHead title="History" aside="newest first" />
      {data.events.map((event) => (
        <Row
          key={event.id}
          label={event.kind.replaceAll("_", " ")}
          annotation={
            <Evidence size="sm" kind="note">
              {event.strengthBefore.toFixed(2)} → {event.strengthAfter.toFixed(2)} ·{" "}
              {formatTime(event.createdAt)}
            </Evidence>
          }
        >
          {event.note ?? event.statementAfter ?? ""}
        </Row>
      ))}
      <Unbuilt task="web-decisions" />
    </>
  );
}
