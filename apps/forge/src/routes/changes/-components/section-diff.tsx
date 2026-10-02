import type { ChangeId, DiffLine, FileDiff, Hunk, SectionId } from "@gitflare/core";
import { Evidence, Text } from "@gitflare/ui/components/typography";
import { Skeleton } from "@gitflare/ui/components/ui/skeleton";
import { cn } from "@gitflare/ui/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { changeQueries } from "@/data/changes.queries";
import { diffStat } from "./copy";

const lineTint: Record<DiffLine["kind"], string> = {
  context: "",
  add: "bg-success-tint",
  delete: "bg-danger-tint",
};

const lineSign: Record<DiffLine["kind"], string> = { context: " ", add: "+", delete: "−" };

function HunkLines({ hunk }: { hunk: Hunk }) {
  return (
    <>
      <div className="type-mono-sm px-s4 py-s1 text-faint">
        @@ −{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@
      </div>
      {hunk.lines.map((line) => (
        <div
          key={`${line.kind}:${line.oldLine}:${line.newLine}`}
          className={cn("type-mono-sm flex min-w-max text-ink", lineTint[line.kind])}
        >
          <span className="w-12 shrink-0 pr-s2 text-right text-faint select-none">
            {line.oldLine ?? ""}
          </span>
          <span className="w-12 shrink-0 pr-s2 text-right text-faint select-none">
            {line.newLine ?? ""}
          </span>
          <span className="w-5 shrink-0 text-center text-muted-foreground select-none">
            {lineSign[line.kind]}
          </span>
          <span className="pr-s4 whitespace-pre">{line.text}</span>
        </div>
      ))}
    </>
  );
}

function FileBlock({ file }: { file: FileDiff }) {
  return (
    <div className="border-t border-rule first:border-t-0">
      <div className="flex items-baseline justify-between gap-s6 py-s3">
        <Evidence kind="id" className="min-w-0 break-all">
          {file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
        </Evidence>
        <Evidence size="sm" kind="note" className="shrink-0">
          {file.status} · {diffStat(file.insertions, file.deletions)}
        </Evidence>
      </div>
      {file.hunks.length === 0 ? (
        <Text size="detail" tone="faint" className="pb-s4">
          {file.binary
            ? "A binary or oversized file: its content is not shown."
            : "No line changed."}
        </Text>
      ) : (
        <div className="overflow-x-auto bg-surface pb-s2">
          {file.hunks.map((hunk) => (
            <HunkLines key={hunk.hash} hunk={hunk} />
          ))}
        </div>
      )}
    </div>
  );
}

/** The part of the diff one section presents. Fetched when the reader opens it, not with the page. */
export function SectionDiff({ changeId, sectionId }: { changeId: ChangeId; sectionId: SectionId }) {
  const diff = useQuery(changeQueries.sectionDiff(changeId, sectionId));
  if (diff.isPending) {
    return (
      <div className="flex flex-col gap-s2 py-s4" aria-busy="true">
        <Skeleton className="h-5 w-1/3" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }
  if (diff.isError) {
    return (
      <Text size="detail" className="py-s4 text-danger" role="alert">
        The diff could not be loaded: {diff.error.message}
      </Text>
    );
  }
  return (
    <div>
      {diff.data.files.map((file) => (
        <FileBlock key={file.path} file={file} />
      ))}
    </div>
  );
}
