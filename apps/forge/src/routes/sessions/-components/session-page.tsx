import type { ChangeStatus, CloudSessionEvent, CloudSessionState, SessionId } from "@gitflare/core";
import { can } from "@gitflare/core";
import type { SessionView } from "@gitflare/core/api";
import { Row, SectionHead } from "@gitflare/ui/components/row";
import { Evidence, Text } from "@gitflare/ui/components/typography";
import { Button } from "@gitflare/ui/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@gitflare/ui/components/ui/dialog";
import { Textarea } from "@gitflare/ui/components/ui/textarea";
import { useSuspenseQuery } from "@tanstack/react-query";
import { useState } from "react";
import { RouteLink } from "@/components/shell/link";
import { PageHead } from "@/components/shell/page";
import { accountQueries } from "@/data/account.queries";
import {
  sessionQueries,
  useAbandonSession,
  usePromptSession,
  useStopSession,
} from "@/data/sessions.queries";
import { formatTime } from "@/lib/format";
import { cloudStateCopy } from "./copy";
import { SessionStatus } from "./status";

/** This session's own, minimal reading of a change's status: enough for one line here. */
const changeStatusLabel: Record<ChangeStatus, string> = {
  open: "just pushed",
  processing: "pipeline running",
  ready: "ready for review",
  merged: "merged",
  closed: "closed",
};

/** A hosted agent has something to stop only in these states. */
const stoppableCloudStates: CloudSessionState[] = ["starting", "idle", "working"];

/** Still copying the fork. Nothing else on the page is true yet. */
function Preparing() {
  return (
    <Row label="Preparing">
      <Text tone="muted">
        The fork is being copied. This takes seconds to most of a minute; the page updates on its
        own.
      </Text>
    </Row>
  );
}

function eventLine(event: CloudSessionEvent): string {
  switch (event.type) {
    case "prompt":
      return event.text;
    case "assistant":
      return event.text;
    case "tool":
      return `${event.name} ${event.summary}`;
    case "pushed":
      return `pushed ${event.sha}`;
    case "state":
      return cloudStateCopy[event.state].label;
    case "error":
      return event.message;
  }
}

const eventLabel: Record<CloudSessionEvent["type"], string> = {
  prompt: "Prompt",
  assistant: "Agent",
  tool: "Tool",
  pushed: "Pushed",
  state: "State",
  error: "Error",
};

function Events({ sessionId, polling }: { sessionId: SessionId; polling: boolean }) {
  const { data } = useSuspenseQuery({
    ...sessionQueries.events(sessionId),
    refetchInterval: polling ? 3000 : false,
  });
  if (data.length === 0) {
    return (
      <Text tone="muted" size="body-s">
        Nothing has happened yet.
      </Text>
    );
  }
  return (
    <ul aria-label="What the agent did" className="flex flex-col">
      {data.map((event) => (
        <li key={event.seq}>
          <Row
            label={eventLabel[event.type]}
            annotation={
              <Evidence size="sm" kind="note">
                {formatTime(event.at)}
              </Evidence>
            }
          >
            <Text
              size="body-s"
              tone={event.type === "error" ? undefined : "muted"}
              className={event.type === "error" ? "text-danger" : undefined}
            >
              {eventLine(event)}
            </Text>
          </Row>
        </li>
      ))}
    </ul>
  );
}

function PromptBox({ sessionId }: { sessionId: SessionId }) {
  const [text, setText] = useState("");
  const prompt = usePromptSession();

  return (
    <form
      className="flex flex-col gap-s3"
      onSubmit={(event) => {
        event.preventDefault();
        if (text.trim() === "") return;
        prompt.mutate({ sessionId, text }, { onSuccess: () => setText("") });
      }}
    >
      <Textarea
        value={text}
        onChange={(event) => setText(event.target.value)}
        placeholder="Tell the agent what to do next…"
        aria-label="Prompt"
      />
      <div className="flex items-center gap-s5">
        <Button type="submit" size="sm" disabled={prompt.isPending || text.trim() === ""}>
          {prompt.isPending ? "Sending…" : "Send"}
        </Button>
        {prompt.error && (
          <Text size="detail" className="text-danger" role="alert">
            {prompt.error.message}
          </Text>
        )}
      </div>
    </form>
  );
}

/** Whether there is a stoppable hosted agent to stop, right now. */
function canStopSession(
  { session, cloud }: Pick<SessionView, "session" | "cloud">,
  mayWrite: boolean,
): boolean {
  return (
    mayWrite &&
    session.status === "active" &&
    session.kind === "cloud" &&
    cloud !== null &&
    stoppableCloudStates.includes(cloud.state)
  );
}

function Actions({
  sessionId,
  canStop,
  mayAbandon,
}: {
  sessionId: SessionId;
  canStop: boolean;
  mayAbandon: boolean;
}) {
  const stop = useStopSession();
  const abandon = useAbandonSession();
  const [confirmingAbandon, setConfirmingAbandon] = useState(false);

  return (
    <div className="flex items-center gap-s5">
      {canStop && (
        <Button
          variant="outline"
          disabled={stop.isPending}
          onClick={() => stop.mutate({ sessionId })}
        >
          {stop.isPending ? "Stopping…" : "Stop"}
        </Button>
      )}
      {mayAbandon && (
        <Dialog open={confirmingAbandon} onOpenChange={setConfirmingAbandon}>
          <DialogTrigger
            render={<Button variant="ghost" className="text-danger" disabled={abandon.isPending} />}
          >
            {abandon.isPending ? "Abandoning…" : "Abandon"}
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Abandon this session?</DialogTitle>
            </DialogHeader>
            <DialogBody>
              <DialogDescription>Its fork will be deleted.</DialogDescription>
            </DialogBody>
            <DialogFooter>
              <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
              <Button
                variant="destructive"
                onClick={() => {
                  setConfirmingAbandon(false);
                  abandon.mutate({ sessionId });
                }}
              >
                Abandon
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
      {(stop.error || abandon.error) && (
        <Text size="detail" className="text-danger" role="alert">
          {(stop.error ?? abandon.error)?.message}
        </Text>
      )}
    </div>
  );
}

/** Only poll while the session is still active: an ended session's last reported state is final. */
function polling(status: SessionView): boolean {
  return (
    status.session.status === "active" &&
    (!status.session.forkReadyAt ||
      status.cloud?.state === "starting" ||
      status.cloud?.state === "working")
  );
}

export function SessionPage({ sessionId }: { sessionId: SessionId }) {
  const { data } = useSuspenseQuery({
    ...sessionQueries.detail(sessionId),
    refetchInterval: (query) => (query.state.data && polling(query.state.data) ? 3000 : false),
  });
  const { data: me } = useSuspenseQuery(accountQueries.me());
  const { session, repository, change, pushRemote, cloud } = data;
  const mayWrite = can(me.user, { type: "session.write", session });
  const canStop = canStopSession(data, mayWrite);
  const mayAbandon = can(me.user, { type: "session.abandon", session });
  const showPreparing = !session.forkReadyAt && session.status === "active";

  return (
    <>
      <PageHead
        title={session.title}
        lede={`A ${session.kind} session on ${repository.slug}.`}
        aside={<SessionStatus session={session} cloud={cloud} />}
      />

      {showPreparing ? (
        <Preparing />
      ) : (
        <>
          <Row
            label="Push to"
            annotation={pushRemote ? "only this session can write here" : undefined}
          >
            {pushRemote ? <Evidence>{pushRemote}</Evidence> : "The fork has been deleted."}
          </Row>
          {change && (
            <Row
              label={
                <RouteLink to="/changes/$changeId" params={{ changeId: change.id }}>
                  #{change.number} {change.title}
                </RouteLink>
              }
              annotation={changeStatusLabel[change.status]}
            >
              What this session's pushes opened.
            </Row>
          )}

          {(canStop || mayAbandon) && (
            <>
              <SectionHead title="Actions" className="mt-s9" />
              <Actions sessionId={session.id} canStop={canStop} mayAbandon={mayAbandon} />
            </>
          )}

          {session.kind === "cloud" && (
            <>
              <SectionHead title="Prompt" className="mt-s9" />
              {mayWrite && cloud && cloud.state !== "ended" ? (
                <PromptBox sessionId={session.id} />
              ) : (
                <Text tone="muted" size="body-s">
                  This session cannot be prompted
                  {cloud?.state === "ended" ? ": it has ended." : "."}
                </Text>
              )}

              <SectionHead title="What the agent did" className="mt-s9" />
              <Events sessionId={session.id} polling={session.status === "active"} />
            </>
          )}
        </>
      )}
    </>
  );
}
