import { idSchema } from "@gitflare/core/api";
import { Row, SectionHead } from "@gitflare/ui/components/row";
import { Evidence, Text } from "@gitflare/ui/components/typography";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { PageHead, Unbuilt } from "@/components/shell/page";
import { ChangeThreads, SectionThreads } from "@/components/threads";
import { changeQueries } from "@/data/changes.queries";
import { useChangeLive } from "@/data/live";
import { threadQueries } from "@/data/threads.queries";
import { formatUsd, shortSha } from "@/lib/format";

const changeId = idSchema("change");

export const Route = createFileRoute("/changes/$changeId")({
  params: {
    parse: (params) => {
      const parsed = changeId.safeParse(params.changeId);
      if (!parsed.success) throw notFound();
      return { changeId: parsed.data };
    },
  },
  loader: async ({ context, params }) => {
    await Promise.all([
      context.queryClient.ensureQueryData(changeQueries.detail(params.changeId)),
      context.queryClient.ensureQueryData(threadQueries.list(params.changeId)),
    ]);
  },
  component: ChangePage,
});

function ChangePage() {
  const params = Route.useParams();
  const { data } = useSuspenseQuery(changeQueries.detail(params.changeId));
  const live = useChangeLive(params.changeId, { lastEventSeq: data.lastEventSeq });
  const { change, intent } = data;

  return (
    <>
      <PageHead
        title={change.title}
        lede={intent?.statement}
        aside={
          <Evidence size="sm" kind="note">
            {data.repository.slug} #{change.number} · {change.status} · {live.status}
          </Evidence>
        }
      />
      <SectionHead
        title="Sections"
        aside={`${data.sections.filter((s) => s.approvalState === "approved").length} of ${data.sections.length} approved`}
      />
      {data.sections.map((view) => (
        <Row
          key={view.section.id}
          label={view.section.title}
          annotation={
            <Evidence size="sm" kind="note">
              {view.approvalState} · +{view.insertions} −{view.deletions}
            </Evidence>
          }
        >
          {view.section.explanation}
          <div className="mt-s4">
            <SectionThreads changeId={change.id} sectionId={view.section.id} />
          </div>
        </Row>
      ))}
      <SectionHead title="Conversation" className="mt-s11" />
      <ChangeThreads changeId={change.id} />
      <SectionHead title="Record" className="mt-s11" />
      <Text size="body-s" tone="muted">
        {data.author.name} · {data.session.kind} session · intent derived from the{" "}
        {intent?.grade ?? "…"}
      </Text>
      <Evidence size="sm" kind="note" className="mt-s2 block">
        head {shortSha(change.headSha)} · base {shortSha(change.baseSha)} ·{" "}
        {formatUsd(data.cost.totalMicroUsd)} estimated
      </Evidence>
      <Unbuilt task="web-change" />
    </>
  );
}
