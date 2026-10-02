import type { ChangeId } from "@gitflare/core";
import { PostMessageInput, type ThreadView } from "@gitflare/core/api";
import { ChatTurn, LineThread, LineThreadSummary } from "@gitflare/ui/components/chat";
import { StatusPill } from "@gitflare/ui/components/status";
import { Evidence, Text } from "@gitflare/ui/components/typography";
import { Button } from "@gitflare/ui/components/ui/button";
import { useState } from "react";
import { RouteLink } from "@/components/shell/link";
import { useThreadDraft } from "@/data/live";
import {
  usePostMessage,
  useReclassifyThread,
  useReopenThread,
  useResolveThread,
} from "@/data/threads.queries";
import { formatTime } from "@/lib/format";
import { AskForm } from "./ask-form";
import {
  AGENT_NAME,
  actionCopy,
  anchorCopy,
  dismissalCopy,
  otherDismissal,
  plural,
  settledByName,
  statusCopy,
  threadTitle,
} from "./copy";
import { DismissForm } from "./dismiss-form";
import { MessageBody } from "./message-body";

type MessageView = ThreadView["messages"][number];

function Message({ message, opening }: { message: MessageView; opening: boolean }) {
  const { action } = message;
  return (
    <ChatTurn
      author={message.author.kind === "agent" ? AGENT_NAME : (message.user?.name ?? "Someone")}
      anchor={formatTime(message.createdAt)}
      kind={opening ? "question" : "answer"}
      citations={
        action && (
          <div className="flex flex-wrap items-baseline gap-x-s4 gap-y-s1">
            <Evidence size="xs">{actionCopy(action)}</Evidence>
            {action.type === "recorded_decision" && (
              <RouteLink
                to="/decisions/$decisionId"
                params={{ decisionId: action.decisionId }}
                className="type-detail"
              >
                Read the decision
              </RouteLink>
            )}
          </div>
        )
      }
    >
      <MessageBody>{message.body}</MessageBody>
    </ChatTurn>
  );
}

function Reply({ view }: { view: ThreadView }) {
  const post = usePostMessage();
  const threadId = view.thread.id;
  return (
    <AskForm
      label="Reply"
      placeholder={view.thread.kind === "chat" ? "Ask a follow-up" : "Reply, or ask for a fix"}
      parse={(body) => PostMessageInput.safeParse({ threadId, body })}
      send={(body) => post.mutateAsync({ threadId, body })}
      error={post.error}
    />
  );
}

/**
 * The right column: what state the thread is in, what the review recorded
 * about it, and the reader's own move.
 */
function ThreadRecord({
  view,
  locked,
  dismissing,
  onDismiss,
  onCollapse,
}: {
  view: ThreadView;
  locked: boolean;
  dismissing: boolean;
  onDismiss: () => void;
  onCollapse: () => void;
}) {
  const resolve = useResolveThread();
  const reopen = useReopenThread();
  const reclassify = useReclassifyThread();
  const { thread } = view;
  const ref = { threadId: thread.id };
  const error = resolve.error ?? reopen.error ?? reclassify.error;
  // Only the latest move's error stands: a move that follows a failed one
  // clears what the failure said.
  const clearOthers = (mutation: { reset: () => void }) => {
    for (const other of [resolve, reopen, reclassify]) if (other !== mutation) other.reset();
  };
  const by = settledByName(view);

  if (thread.kind === "chat") {
    return (
      <Text size="detail" tone="faint">
        A chat. It does not hold up the merge.
      </Text>
    );
  }

  return (
    <div className="flex flex-col items-start gap-s3">
      <StatusPill tone={statusCopy[thread.status].tone}>
        {statusCopy[thread.status].label}
      </StatusPill>
      {thread.dismissal && (
        <div>
          <Text size="detail">{dismissalCopy[thread.dismissal].label}</Text>
          <Text size="detail" tone="faint">
            {dismissalCopy[thread.dismissal].consequence}
          </Text>
        </div>
      )}
      {thread.dismissal === "design_decision" && thread.decisionId && (
        <RouteLink
          to="/decisions/$decisionId"
          params={{ decisionId: thread.decisionId }}
          className="type-detail"
        >
          Read the decision
        </RouteLink>
      )}
      {thread.settledAt !== null && (
        <Text size="detail" tone="faint">
          {by ? `By ${by}, ` : ""}
          {formatTime(thread.settledAt)}
        </Text>
      )}
      {(thread.finding || thread.anchor) && (
        <div className="flex flex-col gap-s1">
          {thread.finding && (
            <Evidence as="div" size="sm" kind="note">
              {thread.finding.category.replace("_", " ")} · {thread.finding.severity}
            </Evidence>
          )}
          {thread.anchor && (
            <Evidence as="div" size="sm" kind="note" className="wrap-anywhere">
              {anchorCopy(thread.anchor)}
            </Evidence>
          )}
        </div>
      )}
      {thread.finding?.decisionIds.map((decisionId) => (
        <RouteLink
          key={decisionId}
          to="/decisions/$decisionId"
          params={{ decisionId }}
          className="type-detail"
        >
          The decision it cites
        </RouteLink>
      ))}

      {!locked && thread.status === "open" && !dismissing && (
        <>
          <Button
            size="sm"
            variant="outline"
            disabled={resolve.isPending}
            onClick={() => {
              clearOthers(resolve);
              resolve.mutate(ref);
            }}
          >
            {resolve.isPending ? "Resolving…" : "Resolve"}
          </Button>
          <Button variant="link" size="xs" disabled={resolve.isPending} onClick={onDismiss}>
            Dismiss…
          </Button>
        </>
      )}
      {!locked && thread.dismissal && (
        <Button
          variant="link"
          size="xs"
          disabled={reclassify.isPending}
          onClick={() => {
            clearOthers(reclassify);
            reclassify.mutate({
              ...ref,
              classification: otherDismissal(thread.dismissal ?? "not_a_problem"),
            });
          }}
        >
          {reclassify.isPending
            ? "Reclassifying…"
            : `Reclassify ${dismissalCopy[otherDismissal(thread.dismissal)].as}`}
        </Button>
      )}
      {!locked && thread.status !== "open" && (
        <Button
          variant="link"
          size="xs"
          disabled={reopen.isPending}
          onClick={() => {
            clearOthers(reopen);
            reopen.mutate(ref);
          }}
        >
          {reopen.isPending ? "Reopening…" : "Reopen"}
        </Button>
      )}
      {thread.status !== "open" && (
        <Button variant="link" size="xs" onClick={onCollapse}>
          Collapse
        </Button>
      )}
      {error && (
        <Text size="detail" className="text-danger" role="alert">
          {error.message}
        </Text>
      )}
    </div>
  );
}

/**
 * One thread: the conversation on the left, its state and what settles it on
 * the right. A settled thread keeps its place as one line until it is opened;
 * one the reader settles here stays open in front of them.
 */
export function ThreadBlock({
  view,
  changeId,
  locked,
}: {
  view: ThreadView;
  changeId: ChangeId;
  /** The change is merged or closed: the thread is read, not worked on. */
  locked: boolean;
}) {
  const { thread, messages } = view;
  const [expanded, setExpanded] = useState(thread.status === "open");
  const [dismissing, setDismissing] = useState(false);
  const draft = useThreadDraft(changeId, thread.id);
  const title = threadTitle(view);
  const open = thread.status === "open";
  // An open thread is never folded away: when someone reopens one the reader
  // had collapsed, it opens here too, since it now holds up the merge.
  if (open && !expanded) setExpanded(true);

  // A reply being typed is shown even on a thread the reader had collapsed.
  if (!expanded && draft === null) {
    const state = thread.dismissal
      ? `dismissed ${dismissalCopy[thread.dismissal].as}`
      : thread.status;
    return (
      <article aria-label={title}>
        <LineThreadSummary
          quote={title}
          meta={`${state} · ${plural(messages.length, "message")}`}
          aria-expanded={false}
          onClick={() => setExpanded(true)}
        />
      </article>
    );
  }

  return (
    <article aria-label={title}>
      <LineThread state={open && thread.kind === "comment" ? "live" : "settled"}>
        <div className="grid gap-x-s9 gap-y-s5 md:grid-cols-[minmax(0,1fr)_220px]">
          <div className="flex max-w-body min-w-0 flex-col gap-[18px]">
            {thread.finding && (
              <h4 className="font-display text-body-m leading-body-s font-medium tracking-heading text-ink">
                {title}
              </h4>
            )}
            <ol aria-label="Messages" className="flex flex-col gap-[18px]">
              {messages.map((message, index) => (
                <li key={message.id}>
                  <Message message={message} opening={index === 0 && !thread.finding} />
                </li>
              ))}
              {draft !== null && (
                <li aria-label="Reply being written">
                  <ChatTurn author={AGENT_NAME} activity="replying" streaming>
                    <MessageBody>{draft}</MessageBody>
                  </ChatTurn>
                </li>
              )}
            </ol>
            {!locked && open && dismissing && (
              <DismissForm threadId={thread.id} onDone={() => setDismissing(false)} />
            )}
            {!locked && open && !dismissing && <Reply view={view} />}
          </div>
          <ThreadRecord
            view={view}
            locked={locked}
            dismissing={dismissing}
            onDismiss={() => setDismissing(true)}
            onCollapse={() => setExpanded(false)}
          />
        </div>
      </LineThread>
    </article>
  );
}
