import type { MergeBlocker } from "@gitflare/core";
import type { ChangeDetail } from "@gitflare/core/api";
import {
  FloatingCard,
  FloatingCardActions,
  FloatingCardBody,
  FloatingCardHead,
} from "@gitflare/ui/components/floating-card";
import { StatusBadge } from "@gitflare/ui/components/status";
import { Evidence, Heading, Text, TextLink } from "@gitflare/ui/components/typography";
import { Button } from "@gitflare/ui/components/ui/button";
import type { ReactNode } from "react";
import { useMergeChange } from "@/data/changes.queries";
import { formatTime, shortSha } from "@/lib/format";
import { blockerCopy, plural } from "./copy";
import { sectionAnchor } from "./section";

function Blocker({
  blocker,
  sections,
}: {
  blocker: MergeBlocker;
  sections: ChangeDetail["sections"];
}) {
  return (
    <li>
      <Text size="body-s" tone="muted">
        {blockerCopy(blocker)}
      </Text>
      {blocker.kind === "sections_unapproved" && (
        <ul className="mt-s1 flex flex-col gap-s1">
          {blocker.sectionIds.map((sectionId) => (
            <li key={sectionId}>
              <TextLink href={`#${sectionAnchor(sectionId)}`} className="type-body-s">
                {sections.find((view) => view.section.id === sectionId)?.section.title ??
                  "A section"}
              </TextLink>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

function Card({
  state,
  tone,
  children,
}: {
  state: string;
  tone: "success" | "neutral";
  children: ReactNode;
}) {
  return (
    <FloatingCard aria-label="Merge readiness" className="xl:sticky xl:top-s7">
      <FloatingCardHead>
        <Text as="span" size="meta" tone="muted">
          Merge
        </Text>
        <StatusBadge tone={tone}>{state}</StatusBadge>
      </FloatingCardHead>
      <FloatingCardBody>{children}</FloatingCardBody>
    </FloatingCard>
  );
}

/**
 * The page's one elevated surface: whether the change may merge, what still
 * stands in the way, and the merge itself. The button exists only when
 * `readiness.ready`; until then the card is the list of what is left.
 */
export function MergeCard({
  change,
  readiness,
  sections,
  stages,
}: Pick<ChangeDetail, "change" | "readiness" | "sections" | "stages">) {
  const merge = useMergeChange();

  if (change.status === "merged") {
    return (
      <Card state="merged" tone="success">
        <Heading level={3} size="title">
          This change is in main.
        </Heading>
        <Text size="body-s" tone="muted">
          Merged{change.mergedAt ? ` ${formatTime(change.mergedAt)}` : ""}. The session has ended
          and its fork is gone.
        </Text>
        {change.mergeSha && (
          <Evidence size="sm" kind="note">
            merge {shortSha(change.mergeSha)}
          </Evidence>
        )}
      </Card>
    );
  }

  if (change.status === "closed") {
    return (
      <Card state="closed" tone="neutral">
        <Heading level={3} size="title">
          Closed without merging.
        </Heading>
        <Text size="body-s" tone="muted">
          Abandoned{change.closedAt ? ` ${formatTime(change.closedAt)}` : ""}. Nothing from this
          change reached main.
        </Text>
      </Card>
    );
  }

  if (!readiness.ready) {
    return (
      <Card state="not ready" tone="neutral">
        <Heading level={3} size="title">
          {plural(readiness.blockers.length, "thing")} to settle before this can merge.
        </Heading>
        <ul aria-label="What blocks the merge" className="flex flex-col gap-s4">
          {readiness.blockers.map((blocker) => (
            <Blocker key={blocker.kind} blocker={blocker} sections={sections} />
          ))}
        </ul>
      </Card>
    );
  }

  const ci = stages.find((run) => run.stage === "ci");
  return (
    <Card state="ready" tone="success">
      <Heading level={3} size="title">
        Nothing stands in the way.
      </Heading>
      <Text size="body-s" tone="muted">
        Every section has a current approval, every comment is settled, and CI{" "}
        {ci?.status === "skipped" ? "was skipped" : "passed"}.
      </Text>
      <FloatingCardActions>
        <Button
          variant="flare"
          disabled={merge.isPending}
          onClick={() => merge.mutate({ changeId: change.id })}
        >
          {merge.isPending ? "Merging…" : "Merge into main"}
        </Button>
      </FloatingCardActions>
      {merge.error && (
        <Text size="detail" className="text-danger" role="alert">
          {merge.error.message}
        </Text>
      )}
    </Card>
  );
}
