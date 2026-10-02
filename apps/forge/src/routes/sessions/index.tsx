import { Row } from "@gitflare/ui/components/row";
import { Evidence } from "@gitflare/ui/components/typography";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { RouteLink } from "@/components/shell/link";
import { PageHead, Unbuilt } from "@/components/shell/page";
import { sessionQueries } from "@/data/sessions.queries";

export const Route = createFileRoute("/sessions/")({
  loader: ({ context }) => context.queryClient.ensureQueryData(sessionQueries.mine()),
  component: Sessions,
});

function Sessions() {
  const { data } = useSuspenseQuery(sessionQueries.mine());
  return (
    <>
      <PageHead
        title="Sessions"
        lede="Your work in progress. A session is a fork, the commits pushed to it and how they were made, wherever it runs."
      />
      {data.map((view) => (
        <Row
          key={view.session.id}
          label={
            <RouteLink to="/sessions/$sessionId" params={{ sessionId: view.session.id }}>
              {view.session.title}
            </RouteLink>
          }
          annotation={
            <Evidence size="sm" kind="note">
              {view.session.kind} · {view.cloud?.state ?? view.session.status}
            </Evidence>
          }
        >
          {view.repository.slug}
        </Row>
      ))}
      <Unbuilt task="web-sessions" />
    </>
  );
}
