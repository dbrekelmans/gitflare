import type { ChangeId } from "@gitflare/core";
import type { ChangeDetail } from "@gitflare/core/api";
import { SectionHead } from "@gitflare/ui/components/row";
import { StatusPill } from "@gitflare/ui/components/status";
import { Evidence, Text } from "@gitflare/ui/components/typography";
import { useSuspenseQuery } from "@tanstack/react-query";
import { RouteLink } from "@/components/shell/link";
import { PageHead } from "@/components/shell/page";
import { ChangeThreads } from "@/components/threads";
import { accountQueries } from "@/data/account.queries";
import { changeQueries } from "@/data/changes.queries";
import { type LiveStatus, useChangeLive } from "@/data/live";
import { changeStatusCopy } from "./copy";
import { MergeCard } from "./merge-card";
import { CommitsFact, CostFact } from "./record";
import { SectionBlock } from "./section";
import { CaptureFact, IntentFact, PipelineFact } from "./summary";

const liveCopy: Record<LiveStatus, string> = {
  live: "live",
  connecting: "connecting",
  offline: "not live · reload to refresh",
};

function Whereabouts({ data, live }: { data: ChangeDetail; live: LiveStatus }) {
  const status = changeStatusCopy[data.change.status];
  return (
    <div className="flex flex-col items-end gap-s2 text-right">
      <StatusPill tone={status.tone}>{status.label}</StatusPill>
      <Text size="detail" tone="muted">
        <RouteLink to="/repos/$repoSlug" params={{ repoSlug: data.repository.slug }} tone="quiet">
          {data.repository.slug}
        </RouteLink>{" "}
        #{data.change.number} · {data.author.name},{" "}
        <RouteLink to="/sessions/$sessionId" params={{ sessionId: data.session.id }} tone="quiet">
          {data.session.kind} session
        </RouteLink>
      </Text>
      <Evidence size="sm" kind="note">
        {liveCopy[live]}
      </Evidence>
    </div>
  );
}

/** Why there is nothing to approve, when there is nothing. */
function NoSections({ stages }: Pick<ChangeDetail, "stages">) {
  const run = stages.find((stage) => stage.stage === "sections");
  return (
    <Text tone="muted">
      {run?.status === "failed"
        ? `Sectioning failed${run.reason ? `: ${run.reason}` : "."} Re-run it above to get sections to approve.`
        : run?.status === "succeeded" || run?.status === "skipped"
          ? "Sectioning finished and produced no sections."
          : "The change is still being divided into sections."}
    </Text>
  );
}

/**
 * The page a reviewer works on. It reads top to bottom in the order a review
 * goes: what the change is for and how far to trust that, whether the
 * pipeline is done, each section with its approval, the conversation, and
 * last what it all cost. The merge card stays beside the sections.
 */
export function ChangePage({ changeId }: { changeId: ChangeId }) {
  const { data } = useSuspenseQuery(changeQueries.detail(changeId));
  const { data: me } = useSuspenseQuery(accountQueries.me());
  const live = useChangeLive(changeId, { lastEventSeq: data.lastEventSeq });
  const { change, sections } = data;
  const approved = sections.filter((view) => view.approvalState === "approved").length;

  return (
    <>
      <PageHead
        title={change.title}
        lede={data.intent?.statement}
        aside={<Whereabouts data={data} live={live.status} />}
      />
      <IntentFact intent={data.intent} />
      <CaptureFact capture={data.capture} />
      <PipelineFact change={change} stages={data.stages} revisions={data.revisions} />

      <SectionHead
        title="Sections"
        aside={sections.length > 0 ? `${approved} of ${sections.length} approved` : undefined}
        className="mt-s9"
      />
      <div className="grid items-start gap-x-s11 gap-y-s9 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="min-w-0">
          {sections.length === 0 ? (
            <NoSections stages={data.stages} />
          ) : (
            sections.map((view) => (
              <SectionBlock
                key={view.section.id}
                view={view}
                change={change}
                viewer={me.user}
                total={sections.length}
              />
            ))
          )}
        </div>
        <MergeCard
          change={change}
          readiness={data.readiness}
          sections={sections}
          stages={data.stages}
        />
      </div>

      <SectionHead title="Conversation" className="mt-s11" />
      <ChangeThreads changeId={change.id} />

      <SectionHead title="Record" className="mt-s11" />
      <CostFact cost={data.cost} />
      <CommitsFact commits={data.commits} revisions={data.revisions} />
    </>
  );
}
