import { type Change, isApprovalCurrent, type User } from "@gitflare/core";
import type { SectionView } from "@gitflare/core/api";
import { ChevronDown } from "@gitflare/ui/components/icons";
import { StatusPill } from "@gitflare/ui/components/status";
import { Evidence, Heading, Text } from "@gitflare/ui/components/typography";
import { Button } from "@gitflare/ui/components/ui/button";
import { cn } from "@gitflare/ui/lib/utils";
import { useId, useState } from "react";
import { SectionThreads } from "@/components/threads";
import { useApproveSection, useRevokeApproval } from "@/data/changes.queries";
import { formatTime } from "@/lib/format";
import { approvalCopy, approvalStatusCopy, diffStat, plural, withdrawalCopy } from "./copy";
import { Prose } from "./prose";
import { SectionDiff } from "./section-diff";

type ApprovalView = SectionView["approvals"][number];

/** The id a section's block carries, so the merge card can link to what still needs approval. */
export function sectionAnchor(sectionId: string): string {
  return `section-${sectionId}`;
}

function ApprovalLine({ approval, current }: { approval: ApprovalView; current: boolean }) {
  return (
    <li>
      <Text size="detail" tone={current ? "ink" : "faint"}>
        {approvalCopy(approval, current)}
      </Text>
      {approval.selfApproval && (
        <Text size="detail" tone={current ? "muted" : "faint"}>
          Self-approval
        </Text>
      )}
      <Text size="detail" tone="faint">
        {formatTime(approval.createdAt)}
      </Text>
      {!current && (
        <Text size="detail" tone="faint">
          Withdrawn{approval.withdrawnAt ? ` ${formatTime(approval.withdrawnAt)}` : ""}:{" "}
          {withdrawalCopy(approval)}
        </Text>
      )}
    </li>
  );
}

/** Who has approved the section, who did and no longer does, and the viewer's own move. */
function SectionApproval({
  view,
  change,
  viewer,
}: {
  view: SectionView;
  change: Change;
  viewer: User;
}) {
  const approve = useApproveSection();
  const revoke = useRevokeApproval();
  const status = approvalStatusCopy(view);
  const input = { changeId: change.id, sectionId: view.section.id };
  const settled = change.status === "merged" || change.status === "closed";
  const mine = view.approvals.some(
    (approval) => approval.userId === viewer.id && isApprovalCurrent(approval, view.section),
  );
  const ownChange = change.authorId === viewer.id;
  const error = approve.error ?? revoke.error;

  return (
    <div className="flex flex-col items-start gap-s4">
      <StatusPill tone={status.tone}>{status.label}</StatusPill>
      {view.approvals.length > 0 && (
        <ul aria-label="Approval history" className="flex flex-col gap-s3">
          {view.approvals.map((approval) => (
            <ApprovalLine
              key={approval.id}
              approval={approval}
              current={isApprovalCurrent(approval, view.section)}
            />
          ))}
        </ul>
      )}
      {!settled &&
        (mine ? (
          <Button
            variant="link"
            size="xs"
            disabled={revoke.isPending}
            onClick={() => {
              approve.reset();
              revoke.mutate(input);
            }}
          >
            {revoke.isPending ? "Withdrawing…" : "Withdraw my approval"}
          </Button>
        ) : (
          <>
            <Button
              size="sm"
              variant={view.approvalState === "approved" ? "outline" : "default"}
              disabled={approve.isPending}
              onClick={() => {
                revoke.reset();
                approve.mutate(input);
              }}
            >
              {approve.isPending ? "Approving…" : "Approve"}
            </Button>
            {ownChange && (
              <Text size="detail" tone="faint">
                You wrote this change. Your approval is recorded as a self-approval.
              </Text>
            )}
          </>
        ))}
      {error && (
        <Text size="detail" className="text-danger" role="alert">
          {error.message}
        </Text>
      )}
    </div>
  );
}

/**
 * One section as a reviewer reads it: what changed and why on the left, who
 * stands behind it on the right, and the diff behind one click.
 */
export function SectionBlock({
  view,
  change,
  viewer,
  total,
}: {
  view: SectionView;
  change: Change;
  viewer: User;
  total: number;
}) {
  const [diffOpen, setDiffOpen] = useState(false);
  const titleId = useId();
  const diffId = useId();
  const { section } = view;

  return (
    <section
      id={sectionAnchor(section.id)}
      aria-labelledby={titleId}
      className="scroll-mt-s7 border-t border-rule pt-s7 pb-s9 first:border-t-0 first:pt-0"
    >
      <div className="grid gap-x-s9 gap-y-s6 md:grid-cols-[minmax(0,1fr)_220px]">
        <div className="min-w-0">
          <Text size="detail" tone="faint">
            {section.position + 1} of {total} · {section.kind}
          </Text>
          <Heading level={3} size="title" id={titleId} className="mt-s1">
            {section.title}
          </Heading>
          <Prose className="mt-s3 max-w-body">{section.explanation}</Prose>
          <div className="mt-s5 flex flex-wrap items-baseline gap-x-s5 gap-y-s1">
            <Button
              variant="link"
              aria-expanded={diffOpen}
              aria-controls={diffId}
              onClick={() => setDiffOpen((open) => !open)}
            >
              {diffOpen ? "Hide the diff" : "Read the diff"}
              <ChevronDown className={cn("transition-transform", diffOpen && "rotate-180")} />
            </Button>
            <Evidence size="sm" kind="note">
              {plural(view.filesChanged, "file")} · {diffStat(view.insertions, view.deletions)}
            </Evidence>
          </div>
        </div>
        <SectionApproval view={view} change={change} viewer={viewer} />
      </div>
      <div id={diffId} className={cn(diffOpen && "mt-s5 border-y border-rule")}>
        {diffOpen && <SectionDiff changeId={change.id} sectionId={section.id} />}
      </div>
      <div className="mt-s5">
        <SectionThreads changeId={change.id} sectionId={section.id} />
      </div>
    </section>
  );
}
