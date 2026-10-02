import { idSchema } from "@gitflare/core/api";
import { Row, SectionHead } from "@gitflare/ui/components/row";
import { Evidence } from "@gitflare/ui/components/typography";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { PageHead, Unbuilt } from "@/components/shell/page";
import { sessionQueries } from "@/data/sessions.queries";
import { formatTime } from "@/lib/format";

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
    ]);
  },
  component: SessionPage,
});

function SessionPage() {
  const params = Route.useParams();
  const { data } = useSuspenseQuery(sessionQueries.detail(params.sessionId));
  const { data: events } = useSuspenseQuery(sessionQueries.events(params.sessionId));
  return (
    <>
      <PageHead
        title={data.session.title}
        lede={`A ${data.session.kind} session on ${data.repository.slug}.`}
        aside={
          <Evidence size="sm" kind="note">
            {data.cloud?.state ?? data.session.status}
          </Evidence>
        }
      />
      <Row label="Push to" annotation="only this session can write here">
        <Evidence>{data.pushRemote}</Evidence>
      </Row>
      <SectionHead title="What the agent did" className="mt-s11" />
      {events.map((event) => (
        <Row
          key={event.seq}
          label={event.type}
          annotation={
            <Evidence size="sm" kind="note">
              {formatTime(event.at)}
            </Evidence>
          }
        >
          {"text" in event && event.text}
          {event.type === "tool" && <Evidence>{`${event.name} ${event.summary}`}</Evidence>}
          {event.type === "pushed" && <Evidence>{event.sha}</Evidence>}
          {event.type === "state" && event.state}
        </Row>
      ))}
      <Unbuilt task="web-sessions" />
    </>
  );
}
