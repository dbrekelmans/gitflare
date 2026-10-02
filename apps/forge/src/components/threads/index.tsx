import type { ChangeId, SectionId } from "@gitflare/core";
import { OpenThreadInput, type ThreadView } from "@gitflare/core/api";
import { Text } from "@gitflare/ui/components/typography";
import { Button } from "@gitflare/ui/components/ui/button";
import { useSuspenseQuery } from "@tanstack/react-query";
import { useState } from "react";
import { changeQueries } from "@/data/changes.queries";
import { threadQueries, useOpenThread } from "@/data/threads.queries";
import { AskForm } from "./ask-form";
import { inReadingOrder } from "./copy";
import { ThreadBlock } from "./thread";

// The conversation on a change: review comments with their replies, and
// chats with the agent. The change page places these components and knows
// nothing about what is inside them. A reply being typed comes from
// `useThreadDraft` in `@/data/live`, which shares the page's one connection.

/** The change's threads, and whether the change is past being worked on. */
function useThreads(changeId: ChangeId) {
  const { data: threads } = useSuspenseQuery(threadQueries.list(changeId));
  const { data: status } = useSuspenseQuery({
    ...changeQueries.detail(changeId),
    select: (detail) => detail.change.status,
  });
  return { threads, locked: status === "merged" || status === "closed" };
}

function ThreadList({
  label,
  threads,
  changeId,
  locked,
}: {
  label: string;
  threads: ThreadView[];
  changeId: ChangeId;
  locked: boolean;
}) {
  if (threads.length === 0) return null;
  return (
    <ul aria-label={label} className="flex flex-col gap-s7">
      {inReadingOrder(threads).map((view) => (
        <li key={view.thread.id}>
          <ThreadBlock view={view} changeId={changeId} locked={locked} />
        </li>
      ))}
    </ul>
  );
}

/** The field a chat starts from, about the whole change or about one section. */
function StartChat({
  changeId,
  sectionId,
  onSent,
}: {
  changeId: ChangeId;
  sectionId?: SectionId;
  onSent?: () => void;
}) {
  const open = useOpenThread();
  const input = (body: string) => ({ changeId, kind: "chat" as const, sectionId, body });
  return (
    <AskForm
      label={sectionId ? "Ask about this section" : "Ask about this change"}
      placeholder={sectionId ? "Ask about this section" : "Ask about this change"}
      size={sectionId ? "inline" : "page"}
      parse={(body) => OpenThreadInput.safeParse(input(body))}
      send={async (body) => {
        await open.mutateAsync(input(body));
        onSent?.();
      }}
      error={open.error}
    />
  );
}

/** The threads pinned to one section, open comments first, and the way to ask about it. */
export function SectionThreads({
  changeId,
  sectionId,
}: {
  changeId: ChangeId;
  sectionId: SectionId;
}) {
  const { threads, locked } = useThreads(changeId);
  const [asking, setAsking] = useState(false);
  const here = threads.filter((view) => view.thread.sectionId === sectionId);
  if (here.length === 0 && locked) return null;
  return (
    <div className="flex flex-col gap-s6">
      <ThreadList
        label="Threads on this section"
        threads={here}
        changeId={changeId}
        locked={locked}
      />
      {!locked &&
        (asking ? (
          <div className="max-w-body">
            <StartChat changeId={changeId} sectionId={sectionId} onSent={() => setAsking(false)} />
          </div>
        ) : (
          <div>
            <Button variant="link" size="xs" onClick={() => setAsking(true)}>
              Ask about this section
            </Button>
          </div>
        ))}
    </div>
  );
}

/** The change-level conversation: threads that belong to no section, and the field to start one. */
export function ChangeThreads({ changeId }: { changeId: ChangeId }) {
  const { threads, locked } = useThreads(changeId);
  const here = threads.filter((view) => view.thread.sectionId === null);
  return (
    <div className="flex flex-col gap-s7">
      {!locked && (
        <div className="max-w-body">
          <StartChat changeId={changeId} />
        </div>
      )}
      <ThreadList
        label="Threads on the change"
        threads={here}
        changeId={changeId}
        locked={locked}
      />
      {here.length === 0 && (
        <Text tone="muted">Nothing has been said about the change as a whole.</Text>
      )}
    </div>
  );
}
