import { Row, SectionHead } from "@gitflare/ui/components/row";
import { Evidence } from "@gitflare/ui/components/typography";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { RouteLink } from "@/components/shell/link";
import { PageHead, Unbuilt } from "@/components/shell/page";
import { repositoryQueries } from "@/data/repositories.queries";
import { formatTime, shortSha } from "@/lib/format";

export const Route = createFileRoute("/repos/$repoSlug/")({
  loader: ({ context, params }) =>
    context.queryClient.ensureQueryData(repositoryQueries.detail(params.repoSlug)),
  component: RepositoryPage,
});

function RepositoryPage() {
  const { repoSlug } = Route.useParams();
  const { data } = useSuspenseQuery(repositoryQueries.detail(repoSlug));
  return (
    <>
      <PageHead
        title={data.repository.slug}
        lede={data.repository.description}
        aside={
          <RouteLink standalone to="/repos/$repoSlug/decisions" params={{ repoSlug }}>
            {data.activeDecisions} decisions
          </RouteLink>
        }
      />
      <Row label="Clone" annotation="read-only; work happens in a session's fork">
        <Evidence>git clone {data.remote}</Evidence>
      </Row>
      <Row label="Context" annotation="checkpoints and decisions">
        <Evidence>{data.contextRemote}</Evidence>
      </Row>
      <SectionHead title="Merged" className="mt-s11" />
      {data.recentCommits.map((commit) => (
        <Row
          key={commit.sha}
          label={commit.message.split("\n")[0]}
          annotation={
            <Evidence size="sm" kind="note">
              {shortSha(commit.sha)} · {formatTime(commit.authoredAt)}
            </Evidence>
          }
        >
          {commit.author.name}
        </Row>
      ))}
      <Unbuilt task="web-inbox-repos" />
    </>
  );
}
