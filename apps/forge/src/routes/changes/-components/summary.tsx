import {
  type Change,
  canRerunStage,
  canTransitionChange,
  type StageRun,
  stageNames,
} from "@gitflare/core";
import type { ChangeDetail } from "@gitflare/core/api";
import { StatusDot } from "@gitflare/ui/components/status";
import { Evidence, Text } from "@gitflare/ui/components/typography";
import { Button } from "@gitflare/ui/components/ui/button";
import { useRerunStage } from "@/data/changes.queries";
import { shortSha } from "@/lib/format";
import {
  captureCopy,
  diffStat,
  intentGradeCopy,
  plural,
  stageLabel,
  stageStatusCopy,
  stageTone,
} from "./copy";
import { Fact } from "./fact";

/** A claim and what qualifies it: the first sentence in ink, the rest quieter. */
function Statement({ headline, detail }: { headline: string; detail: string }) {
  return (
    <Text tone="muted">
      <span className="font-medium text-ink">{headline}</span> {detail}
    </Text>
  );
}

function EvidenceLines({ lines }: { lines: string[] }) {
  return (
    <>
      {lines.map((line) => (
        <Evidence key={line} as="div" size="sm" kind="note" className="break-all">
          {line}
        </Evidence>
      ))}
    </>
  );
}

/** How far to trust the intent in the page's lede: where it came from. */
export function IntentFact({ intent }: Pick<ChangeDetail, "intent">) {
  if (!intent) {
    return (
      <Fact label="Intent">
        <Statement
          headline="Not derived yet."
          detail="The intent stage has not produced a statement of what this change is for."
        />
      </Fact>
    );
  }
  return (
    <Fact
      label="Intent"
      annotation={
        <EvidenceLines
          lines={[
            `intent v${intent.version} · ${intent.grade}`,
            ...(intent.model ? [intent.model] : []),
          ]}
        />
      }
    >
      <Statement {...intentGradeCopy[intent.grade]} />
    </Fact>
  );
}

/** Whether the session that made the change left a record: present, pending, missing or none. */
export function CaptureFact({ capture }: Pick<ChangeDetail, "capture">) {
  const lines = [
    ...capture.sessions.flatMap((session) => [
      [session.agent, session.model].filter(Boolean).join(" · "),
      ...(session.attribution
        ? [`${session.attribution.agentPercentage}% of lines by the agent`]
        : []),
      ...session.checkpointIds
        .filter((id) => !capture.missingCheckpointIds.includes(id))
        .map((id) => `checkpoint ${id}`),
    ]),
    ...capture.missingCheckpointIds.map(
      (id) => `${capture.state === "pending" ? "awaiting" : "missing"} ${id}`,
    ),
  ];
  return (
    <Fact
      label="Capture"
      annotation={lines.length > 0 ? <EvidenceLines lines={lines} /> : undefined}
    >
      <Statement {...captureCopy(capture)} />
    </Fact>
  );
}

function StageLine({ run, change }: { run: StageRun; change: Change }) {
  const rerun = useRerunStage();
  const name = stageLabel[run.stage];
  const offered = canRerunStage(run.status) && canTransitionChange(change.status, "stage_rerun");
  return (
    <li className="flex items-baseline gap-s4">
      <StatusDot tone={stageTone[run.status]} size={7} className="translate-y-[-1px]" />
      <div className="min-w-0 flex-1">
        <Text as="span" size="body-s" className="font-medium">
          {name}
        </Text>{" "}
        <Text as="span" size="body-s" tone="muted">
          {stageStatusCopy(run)}
          {run.attempt > 1 ? `, attempt ${run.attempt}` : ""}
        </Text>
        {run.reason && (
          <Text size="detail" tone="faint">
            {run.reason}
          </Text>
        )}
        {rerun.error && (
          <Text size="detail" className="text-danger" role="alert">
            {rerun.error.message}
          </Text>
        )}
      </div>
      {offered && (
        <Button
          variant="link"
          size="xs"
          aria-label={`Re-run ${name}`}
          disabled={rerun.isPending}
          onClick={() => rerun.mutate({ changeId: change.id, stage: run.stage })}
        >
          {rerun.isPending ? "Queueing…" : "Re-run"}
        </Button>
      )}
    </li>
  );
}

/** Each stage's newest attempt for the head revision, with the way to run it again. */
export function PipelineFact({
  change,
  stages,
  revisions,
}: Pick<ChangeDetail, "change" | "stages" | "revisions">) {
  const head = revisions.find((revision) => revision.id === change.headRevisionId);
  const ordered = stageNames.flatMap((stage) => stages.filter((run) => run.stage === stage));
  return (
    <Fact
      label="Pipeline"
      annotation={
        <EvidenceLines
          lines={[
            ...(head
              ? [
                  `revision ${head.number} of ${revisions.length}`,
                  `${plural(head.stats.commits, "commit")} · ${plural(head.stats.filesChanged, "file")} · ${diffStat(head.stats.insertions, head.stats.deletions)}`,
                ]
              : []),
            `head ${shortSha(change.headSha)} · base ${shortSha(change.baseSha)}`,
          ]}
        />
      }
    >
      {ordered.length === 0 ? (
        <Statement
          headline="Not started."
          detail="The pipeline has not claimed the latest push yet."
        />
      ) : (
        <ul aria-label="Stages" className="flex flex-col gap-s2">
          {ordered.map((run) => (
            <StageLine key={run.id} run={run} change={change} />
          ))}
        </ul>
      )}
    </Fact>
  );
}
