import { Row, SectionHead } from "@gitflare/ui/components/row";
import { StatusPill } from "@gitflare/ui/components/status";
import { Evidence, Text } from "@gitflare/ui/components/typography";
import { useSuspenseQuery } from "@tanstack/react-query";
import { RouteLink } from "@/components/shell/link";
import { PageHead } from "@/components/shell/page";
import { repositoryQueries } from "@/data/repositories.queries";
import { formatTime, shortSha } from "@/lib/format";

/**
 * How to turn on session capture, for a repository that does not have it
 * yet. There is no web action for this: the capture client's settings files
 * are committed by `gitflare capture enable`, run from a clone (build task
 * `cli`). This row only says so.
 */
function CaptureRow({ enabled }: { enabled: boolean }) {
  return (
    <Row label="Capture" annotation={enabled ? "on" : "off"}>
      {enabled ? (
        <Text tone="muted">Every session's checkpoints are committed to the context repo.</Text>
      ) : (
        <>
          <Text tone="muted">
            Not committing checkpoints yet. Turn it on from a clone of this repository:
          </Text>
          <Evidence className="mt-s2 block">gitflare capture enable</Evidence>
        </>
      )}
    </Row>
  );
}

/**
 * The provisioning Workflow retries an import for a while before giving up,
 * so a few minutes of `importing` is normal. Past this, `readyAt` staying
 * null more likely means a source the host could never import (too large,
 * not reachable): `completeRepositoryImport` leaves the repository exactly
 * like this on that failure, with nothing in the contract to tell the two
 * apart (see the task comment on GF-34). This is a guess from `createdAt`
 * alone, not a fact the backend reports.
 */
const IMPORT_STALL_MS = 30 * 60 * 1000;

export function RepositoryPage({ repoSlug }: { repoSlug: string }) {
  const { data } = useSuspenseQuery(repositoryQueries.detail(repoSlug));
  const ready = data.repository.readyAt !== null;
  const stalled = !ready && Date.now() - data.repository.createdAt > IMPORT_STALL_MS;
  return (
    <>
      <PageHead
        title={data.repository.slug}
        lede={data.repository.description}
        aside={
          ready ? (
            <RouteLink standalone to="/repos/$repoSlug/decisions" params={{ repoSlug }}>
              {data.activeDecisions} decisions
            </RouteLink>
          ) : (
            <StatusPill tone={stalled ? "warning" : "neutral"}>
              {stalled ? "not responding" : "importing"}
            </StatusPill>
          )
        }
      />
      {!ready ? (
        <Text tone="muted">
          {stalled
            ? "This import has been running a long time and may have failed. Check that the source is reachable and fits, or create the repository again."
            : "This repository is still being imported. Check back shortly: this page will show how to clone it once it is ready."}
        </Text>
      ) : (
        <>
          <Row label="Clone" annotation="read-only; work happens in a session's fork">
            {data.remote ? (
              <Evidence>git clone {data.remote}</Evidence>
            ) : (
              <Text tone="muted">Not available yet.</Text>
            )}
          </Row>
          <Row label="Context" annotation="checkpoints and decisions">
            {data.contextRemote ? (
              <Evidence>{data.contextRemote}</Evidence>
            ) : (
              <Text tone="muted">Not available yet.</Text>
            )}
          </Row>
          <CaptureRow enabled={data.repository.captureEnabled} />
          <SectionHead title="Merged" className="mt-s11" />
          {data.recentCommits.length === 0 ? (
            <Text tone="muted">Nothing has merged yet.</Text>
          ) : (
            data.recentCommits.map((commit) => (
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
            ))
          )}
        </>
      )}
    </>
  );
}
