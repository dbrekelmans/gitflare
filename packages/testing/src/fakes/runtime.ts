import {
  type ChangeEvent,
  type ChangeId,
  type CloudSessionEvent,
  type CloudSessionState,
  type CloudSessionStatus,
  ForgeError,
  type Id,
  type Identity,
  type IdKind,
  makeId,
  type ProvisionParams,
  type Push,
  type RepositoryId,
  type SessionId,
  type StageName,
  type ThreadId,
  type ThreadMessage,
  type Timestamp,
  type TransientChangeSignal,
} from "@gitflare/core";
import type {
  ChangeLive,
  Clock,
  CloudSessions,
  IdentityProvider,
  IdGenerator,
  NewThreadMessage,
  PipelineRunner,
  Provisioner,
  ThreadHost,
} from "@gitflare/core/ports";

/** Always the same person, or nobody. Change `current` to act as someone else. */
export class FakeIdentity implements IdentityProvider {
  constructor(public current: Identity | null) {}

  async identify(): Promise<Identity | null> {
    return this.current;
  }
}

/** A clock that only moves when told to. */
export class ManualClock implements Clock {
  constructor(private time: Timestamp = Date.UTC(2026, 9, 1, 9, 0, 0)) {}

  now(): Timestamp {
    return this.time;
  }

  advance(ms: number): Timestamp {
    this.time += ms;
    return this.time;
  }

  set(time: Timestamp): void {
    this.time = time;
  }
}

/** Ids that count up per kind: `chg_000001`, `chg_000002`, … The same every run. */
export class SequentialIds implements IdGenerator {
  private readonly counters = new Map<IdKind, number>();

  next<K extends IdKind>(kind: K): Id<K> {
    const n = (this.counters.get(kind) ?? 0) + 1;
    this.counters.set(kind, n);
    return makeId(kind, String(n).padStart(6, "0"));
  }
}

/** Keeps what was published instead of sending it anywhere. */
export class RecordingLive implements ChangeLive {
  readonly events: ChangeEvent[] = [];
  readonly signals: { changeId: ChangeId; signal: TransientChangeSignal }[] = [];

  async publish(event: ChangeEvent): Promise<void> {
    this.events.push(event);
  }

  async signal(changeId: ChangeId, signal: TransientChangeSignal): Promise<void> {
    this.signals.push({ changeId, signal });
  }

  /** The types published for one change, in order. Reads well in an assertion. */
  types(changeId: ChangeId): string[] {
    return this.events.filter((event) => event.changeId === changeId).map((event) => event.type);
  }
}

/** Records what the pipeline was asked to do. Set `onPush` to run something in its place. */
export class RecordingPipeline implements PipelineRunner {
  readonly pushes: Push[] = [];
  readonly reruns: { changeId: ChangeId; stage: StageName; attempt: number }[] = [];
  onPush: ((push: Push) => Promise<void>) | null = null;

  async handlePush(push: Push): Promise<void> {
    this.pushes.push(push);
    await this.onPush?.(push);
  }

  async rerunStage(changeId: ChangeId, stage: StageName, attempt: number): Promise<void> {
    this.reruns.push({ changeId, stage, attempt });
  }
}

/**
 * Records what was asked for and does none of it, which is how the real one
 * looks to its caller: the session's fork, the import or the workspace is not
 * ready when the call returns. A test then does the work itself (for a fork,
 * `completeSessionFork`), or sets `run` to have it done on the spot.
 */
export class RecordingProvisioner implements Provisioner {
  readonly forks: SessionId[] = [];
  readonly imports: { repositoryId: RepositoryId; url: string }[] = [];
  workspacePreparations = 0;
  run: ((params: ProvisionParams) => Promise<void>) | null = null;

  async forkSession(sessionId: SessionId): Promise<void> {
    this.forks.push(sessionId);
    await this.run?.({ kind: "fork", sessionId });
  }

  async importRepository(repositoryId: RepositoryId, url: string): Promise<void> {
    this.imports.push({ repositoryId, url });
    await this.run?.({ kind: "import", repositoryId, url });
  }

  async prepareWorkspace(): Promise<void> {
    this.workspacePreparations++;
    await this.run?.({ kind: "workspace" });
  }
}

/**
 * Threads kept in memory. It orders messages and nothing else: it does not
 * write to the database and no agent answers. Set `onPost` to script a reply.
 */
export class FakeThreads implements ThreadHost {
  private readonly messages = new Map<ThreadId, ThreadMessage[]>();
  onPost: ((message: ThreadMessage) => Promise<void>) | null = null;

  constructor(
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  async post(threadId: ThreadId, message: NewThreadMessage): Promise<ThreadMessage> {
    const list = this.messages.get(threadId) ?? [];
    const stored: ThreadMessage = {
      id: this.ids.next("message"),
      threadId,
      seq: list.length + 1,
      author: message.author,
      body: message.body,
      action: message.action ?? null,
      createdAt: this.clock.now(),
    };
    list.push(stored);
    this.messages.set(threadId, list);
    await this.onPost?.(stored);
    return stored;
  }

  list(threadId: ThreadId): ThreadMessage[] {
    return [...(this.messages.get(threadId) ?? [])];
  }
}

type NewSessionEvent = CloudSessionEvent extends infer E
  ? E extends CloudSessionEvent
    ? Omit<E, "sessionId" | "seq" | "at">
    : never
  : never;

/**
 * Hosted sessions with no sandbox behind them. Prompts are recorded; `emit`
 * plays the agent. Like the real one, a session is launched once (a second
 * `launch` does nothing) and takes no prompt before it has been launched.
 */
export class FakeCloudSessions implements CloudSessions {
  /** Every launch that took effect, in order. */
  readonly launches: { sessionId: SessionId; prompt: string }[] = [];
  /**
   * Says whether a session's fork exists. The fake has no database to ask, so
   * unset it takes every fork to exist; set it and `launch` refuses a session
   * whose fork is not ready with `not_ready`, as the real one does.
   */
  forkReady: ((sessionId: SessionId) => boolean) | null = null;
  private readonly log = new Map<SessionId, CloudSessionEvent[]>();
  private readonly states = new Map<SessionId, CloudSessionState>();

  constructor(private readonly clock: Clock) {}

  async launch(sessionId: SessionId, prompt: string): Promise<void> {
    if (this.forkReady && !this.forkReady(sessionId)) {
      throw new ForgeError("not_ready", `The fork of session ${sessionId} is not ready.`);
    }
    if (this.launches.some((launch) => launch.sessionId === sessionId)) return;
    this.launches.push({ sessionId, prompt });
    this.states.set(sessionId, "working");
    this.emit(sessionId, { type: "prompt", text: prompt });
  }

  async prompt(sessionId: SessionId, text: string): Promise<void> {
    if (!this.launches.some((launch) => launch.sessionId === sessionId)) {
      throw new ForgeError("not_ready", `Session ${sessionId} has not been launched.`);
    }
    this.states.set(sessionId, "working");
    this.emit(sessionId, { type: "prompt", text });
  }

  async status(sessionId: SessionId): Promise<CloudSessionStatus> {
    return {
      sessionId,
      state: this.states.get(sessionId) ?? "ended",
      error: null,
      updatedAt: this.clock.now(),
    };
  }

  async events(sessionId: SessionId, after: number): Promise<CloudSessionEvent[]> {
    return (this.log.get(sessionId) ?? []).filter((event) => event.seq > after);
  }

  async stop(sessionId: SessionId): Promise<void> {
    this.setState(sessionId, "asleep");
  }

  /** Appends an event as if the agent had produced it. */
  emit(sessionId: SessionId, event: NewSessionEvent): CloudSessionEvent {
    const list = this.log.get(sessionId) ?? [];
    const stored = {
      ...event,
      sessionId,
      seq: list.length + 1,
      at: this.clock.now(),
    } as CloudSessionEvent;
    list.push(stored);
    this.log.set(sessionId, list);
    return stored;
  }

  setState(sessionId: SessionId, state: CloudSessionState): void {
    this.states.set(sessionId, state);
    this.emit(sessionId, { type: "state", state });
  }
}
