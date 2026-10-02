import {
  type AgentAction,
  type Change,
  can,
  type FileDiff,
  ForgeError,
  type Session,
  type Sha,
  type Thread,
  type ThreadId,
  type ThreadMessage,
  type UserId,
} from "@gitflare/core";
import { type FileChange, type GenerateResult, ModelError } from "@gitflare/core/ports";
import { appendMessage } from "./messages";
import {
  type ThreadTurnMaterial,
  type TurnOptions,
  type TurnReply,
  threadTurnMessage,
  threadTurnSystem,
  turnSchema,
} from "./prompts/thread-turn";
import { applyThreadAction, recordDismissalDecision } from "./settle";
import {
  agentAuthor,
  authorsOf,
  clip,
  latestIntent,
  messagesOf,
  modelSettings,
  type ReviewDeps,
  requireChange,
  requireRepository,
  requireSession,
  requireThread,
  sessionTranscript,
} from "./store";

/** How many decisions a turn is given. */
const DECISIONS = 5;
const MAX_QUERY_CHARS = 4_000;
const MAX_MESSAGE_CHARS = 6_000;
/** A long thread keeps its first message and its newest ones. */
const MAX_MESSAGES = 40;
const MAX_FILE_CHARS = 40_000;
const MAX_FILES_CHARS = 160_000;
const MAX_OUTPUT_TOKENS = 8_000;
/** How often a turn starts over because a person wrote while it was thinking. */
const MAX_RESTARTS = 2;

const decoder = new TextDecoder();

/**
 * The reply's body so far, read out of structured output that is still
 * arriving. The reply is one JSON object with `body` near its start; this
 * finds that string and decodes what has come of it.
 */
export function bodySoFar(partial: string): string {
  const match = /"body"\s*:\s*"((?:[^"\\]|\\[\s\S])*)/.exec(partial);
  if (!match?.[1]) return "";
  // An escape that has only half arrived is left for the next piece.
  const raw = match[1].replace(/\\u[0-9a-fA-F]{0,3}$/, "");
  try {
    return JSON.parse(`"${raw}"`) as string;
  } catch {
    return "";
  }
}

function branchName(ref: string): string {
  return ref.replace(/^refs\/heads\//, "");
}

/** The change's files as they are at `tip`, whole, the thread's own file first, within a budget. */
async function wholeFiles(
  deps: Pick<ReviewDeps, "git">,
  repo: string,
  tip: Sha,
  diff: readonly FileDiff[],
  first: string | null,
): Promise<{ path: string; content: string }[]> {
  const paths = diff
    .filter((file) => file.status !== "deleted" && !file.binary)
    .map((file) => file.path)
    .sort((a, b) => Number(b === first) - Number(a === first));
  const files: { path: string; content: string }[] = [];
  let used = 0;
  for (const path of paths) {
    const bytes = await deps.git.readFile(repo, { ref: tip, path });
    if (!bytes) continue;
    const content = decoder.decode(bytes);
    if (content.length > MAX_FILE_CHARS || used + content.length > MAX_FILES_CHARS) continue;
    used += content.length;
    files.push({ path, content });
  }
  return files;
}

/** The commit a `fix` asks for, checked against what the agent was shown. */
async function fixChanges(
  deps: Pick<ReviewDeps, "git">,
  repo: string,
  tip: Sha,
  shown: readonly { path: string; content: string }[],
  files: Extract<TurnReply, { action: "fix" }>["files"],
): Promise<FileChange[]> {
  const changes: FileChange[] = [];
  for (const file of files) {
    const path = file.path;
    if (path.startsWith("/") || path.split("/").some((part) => part === ".." || part === ".git")) {
      throw new ModelError("invalid_output", `fix: "${path}" is not a path in the repository`);
    }
    const before = shown.find((candidate) => candidate.path === path);
    // A file the agent never read whole would be overwritten blind.
    if (!before && (await deps.git.readFile(repo, { ref: tip, path })) !== null) {
      throw new ModelError("invalid_output", `fix: "${path}" exists and was not shown whole`);
    }
    if (file.content === null) {
      if (before) changes.push({ path, delete: true });
    } else if (file.content !== before?.content) {
      changes.push({ path, content: file.content });
    }
  }
  if (changes.length === 0) throw new ModelError("invalid_output", "fix: nothing was changed");
  return changes;
}

interface TurnContext {
  thread: Thread;
  change: Change;
  session: Session;
  /** The person whose message is being answered. */
  asker: UserId;
  /** The fork's branch tip the turn read, or null when the fork cannot be written. */
  tip: Sha | null;
  files: { path: string; content: string }[];
}

/** Does what the reply chose, and appends the reply with the action it took. */
async function act(
  deps: ReviewDeps,
  context: TurnContext,
  reply: TurnReply,
): Promise<ThreadMessage> {
  const { thread, change, session, asker } = context;
  const say = (body: string, action?: AgentAction) =>
    appendMessage(deps, thread.id, { author: { kind: "agent" }, body, action });

  switch (reply.action) {
    case "reply":
      return say(reply.body);

    case "resolve":
    case "dismiss": {
      const settled = await applyThreadAction(
        deps,
        thread,
        reply.action === "resolve"
          ? { type: "resolve" }
          : { type: "dismiss", classification: "not_a_problem" },
        { userId: asker },
      );
      // Someone settled it while the agent was writing: the reply still stands as a message.
      if (!settled) return say(reply.body);
      const message = await say(
        reply.body,
        reply.action === "resolve"
          ? { type: "resolved" }
          : { type: "dismissed", classification: "not_a_problem" },
      );
      // What a person said to settle a comment may be a rule worth keeping.
      // Learning it is the decision record's own work and never undoes the settling.
      await deps.decisions.learnFromThread(thread.id).catch(() => null);
      return message;
    }

    case "dismiss_as_decision": {
      const decision = thread.decisionId
        ? null
        : await recordDismissalDecision(deps, {
            thread,
            change,
            wording: reply.decision,
            userId: asker,
          });
      const settled = await applyThreadAction(
        deps,
        thread,
        { type: "dismiss", classification: "design_decision" },
        { userId: asker, decisionId: decision?.id },
      );
      if (!settled) return say(reply.body);
      return say(reply.body, { type: "dismissed", classification: "design_decision" });
    }

    case "fix": {
      const { tip } = context;
      if (!tip) throw new ModelError("invalid_output", "fix: the fork cannot be written");
      const changes = await fixChanges(deps, session.forkRepo, tip, context.files, reply.files);
      try {
        const { sha } = await deps.gitWriter.commitFiles({
          repo: session.forkRepo,
          branch: branchName(change.headRef),
          expectedParent: tip,
          changes,
          message: `${reply.commitMessage}\n\nRequested in review of change #${change.number}.`,
          author: agentAuthor,
        });
        return say(reply.body, { type: "pushed_fix", sha });
      } catch (error) {
        if (!(error instanceof ForgeError && error.code === "conflict")) throw error;
        return say(
          "The branch moved while I was working on this, so I pushed nothing. Ask again and I will redo it on top of the new commits.",
        );
      }
    }
  }
}

const failureWords: Record<ModelError["code"], string> = {
  budget_exceeded: "the model budget is spent",
  no_credits: "this deployment has no model credits",
  rate_limited: "the model is rate limited right now",
  invalid_output: "the model's answer was not one I can act on",
  unavailable: "the model is unavailable right now",
};

/**
 * The agent's turn on a thread, run after a person's message. Streams its
 * reply as `thread.delta` signals, then appends it with whatever action it
 * took. Does nothing on a thread the agent has no part in.
 *
 * The agent takes part in the comments its own review raised and in chats; a
 * comment a person opened is between people. It answers a person: a thread
 * whose last message is its own, or that is settled, has nothing to answer,
 * which is also what makes running a finished turn again harmless. When the
 * model cannot answer, the turn says so in the thread rather than leave the
 * person waiting; they can write again to have it retried.
 */
export async function runAgentTurn(
  deps: ReviewDeps,
  threadId: ThreadId,
): Promise<ThreadMessage | null> {
  for (let restarts = 0; ; restarts++) {
    const thread = await requireThread(deps.db, threadId);
    if (thread.status !== "open") return null;
    if (thread.kind !== "chat" && thread.origin !== "review") return null;
    const all = await messagesOf(deps.db, [threadId]);
    const last = all.at(-1);
    if (last?.author.kind !== "user") return null;
    const asker = last.author.userId;
    const change = await requireChange(deps.db, thread.changeId);
    if (change.status === "merged" || change.status === "closed") return null;

    const repository = await requireRepository(deps.db, change.repositoryId);
    const session = await requireSession(deps.db, change.sessionId);
    const authors = await authorsOf(deps.db, all);
    const person = authors.get(asker);
    const tip = await deps.git.resolveRef(session.forkRepo, branchName(change.headRef));
    const options: TurnOptions = {
      canSettle: thread.kind === "comment",
      canFix:
        tip !== null && person !== undefined && can(person, { type: "session.write", session }),
    };

    const diff = tip ? await deps.diffs.between(session.forkRepo, change.baseSha, tip) : [];
    const files = tip
      ? await wholeFiles(deps, session.forkRepo, tip, diff, thread.anchor?.path ?? null)
      : [];
    const kept = all.length > MAX_MESSAGES ? [all[0], ...all.slice(1 - MAX_MESSAGES)] : all;
    const messages: ThreadTurnMaterial["messages"] = kept.flatMap((message) =>
      message
        ? [
            {
              fromPerson: message.author.kind === "user",
              speaker:
                message.author.kind === "user"
                  ? (authors.get(message.author.userId)?.name ?? "someone")
                  : "agent",
              isAuthor: message.author.kind === "user" && message.author.userId === change.authorId,
              body: clip(message.body, MAX_MESSAGE_CHARS),
            },
          ]
        : [],
    );
    const [intent, transcript, settings, retrieved] = await Promise.all([
      latestIntent(deps.db, change.id),
      sessionTranscript(deps, change.id),
      modelSettings(deps.db, repository),
      deps.decisions.retrieve({
        repositoryId: repository.id,
        query: [thread.finding?.title ?? "", ...messages.map((message) => message.body)]
          .join("\n")
          .slice(0, MAX_QUERY_CHARS),
        limit: DECISIONS,
      }),
    ]);

    const say = (body: string) =>
      appendMessage(deps, threadId, { author: { kind: "agent" }, body });
    const schema = turnSchema(options);
    let reply: TurnReply;
    try {
      let arriving = "";
      let shown = "";
      let result: GenerateResult<TurnReply> | undefined;
      const stream = deps.models.stream({
        model: settings.thread,
        system: threadTurnSystem(options),
        messages: [
          {
            role: "user",
            content: threadTurnMessage({
              repositorySlug: repository.slug,
              change,
              intent,
              thread,
              messages,
              session: transcript,
              decisions: retrieved.map((found) => found.decision),
              diff,
              files,
            }),
          },
        ],
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        attribution: {
          agent: "thread",
          repositoryId: repository.id,
          changeId: change.id,
          userId: asker,
          sessionId: change.sessionId,
        },
        output: { name: "thread_turn", schema },
      });
      for await (const event of stream) {
        if (event.type === "done") {
          result = event.result;
          continue;
        }
        arriving += event.text;
        const text = bodySoFar(arriving);
        if (text.length <= shown.length) continue;
        shown = text;
        // The draft is for whoever is watching; the reply does not depend on it arriving.
        await deps.live.signal(change.id, { type: "thread.delta", threadId, text }).catch(() => {});
      }
      const parsed = schema.safeParse(result?.output);
      if (!parsed.success) throw new ModelError("invalid_output", parsed.error.message);
      reply = parsed.data;
    } catch (error) {
      if (!(error instanceof ModelError)) throw error;
      return say(`I could not answer: ${failureWords[error.code]}. Write again to have me retry.`);
    }

    // A person wrote while this reply was being written: it answers a thread
    // that has moved on, so it is thrown away and the turn starts over.
    const now = await requireThread(deps.db, threadId);
    if (now.messageCount !== thread.messageCount && restarts < MAX_RESTARTS) continue;

    try {
      return await act(deps, { thread, change, session, asker, tip, files }, reply);
    } catch (error) {
      if (!(error instanceof ModelError)) throw error;
      return say(`I could not do that: ${failureWords[error.code]}. Write again to have me retry.`);
    }
  }
}
