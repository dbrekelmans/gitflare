import type { ChangeId, SectionId } from "@gitflare/core";
import { Text } from "@gitflare/ui/components/typography";
import { useSuspenseQuery } from "@tanstack/react-query";
import { threadQueries } from "@/data/threads.queries";

// The conversation on a change: review comments with their replies, and
// chats with the agent. The change page places these components and knows
// nothing about what is inside them. Build task: `web-threads`.

/** The comment threads pinned to one section, open ones first. */
export function SectionThreads({
  changeId,
  sectionId,
}: {
  changeId: ChangeId;
  sectionId: SectionId;
}) {
  const { data: threads } = useSuspenseQuery(threadQueries.list(changeId));
  const count = threads.filter((view) => view.thread.sectionId === sectionId).length;
  if (count === 0) return null;
  return (
    <Text size="detail" tone="faint">
      {count} {count === 1 ? "thread" : "threads"} on this section
    </Text>
  );
}

/** The change-level conversation: threads that belong to no section, and the field to start one. */
export function ChangeThreads({ changeId }: { changeId: ChangeId }) {
  const { data: threads } = useSuspenseQuery(threadQueries.list(changeId));
  const count = threads.filter((view) => view.thread.sectionId === null).length;
  return (
    <Text size="detail" tone="faint">
      {count} change-level {count === 1 ? "thread" : "threads"}
    </Text>
  );
}
