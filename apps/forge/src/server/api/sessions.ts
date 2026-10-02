import { openSession } from "@gitflare/artifacts";
import {
  type Action,
  type CloudSessionStatus,
  can,
  ForgeError,
  type Session,
  type SessionId,
} from "@gitflare/core";
import type { ApiContext, ForgeApi, SessionView } from "@gitflare/core/api";
import { schema, toRepository } from "@gitflare/db";
import { closeChange, endSession } from "@gitflare/pipeline";
import { desc, eq } from "drizzle-orm";
import type { Services } from "../services";

/**
 * Sessions: starting one forks the repository; a cloud session also has a hosted agent to
 * prompt, launched by the provisioning Workflow once the fork exists. Build task: `artifacts`.
 * The cloud operations (`prompt`, `events`, `stop`) pass straight through to the
 * `cloudSessions` port, which `cloud-sessions` implements.
 */
export function sessionsApi(services: Services): ForgeApi["sessions"] {
  const { db, git, cloudSessions } = services;

  async function sessionById(id: SessionId): Promise<Session> {
    const [session] = await db
      .select()
      .from(schema.sessions)
      .where(eq(schema.sessions.id, id))
      .limit(1);
    if (!session) throw new ForgeError("not_found", "Session not found");
    return session;
  }

  /** Whether a cloud session's first prompt has been handed to the hosted agent. */
  async function launched(sessionId: SessionId): Promise<boolean> {
    const [launch] = await db
      .select({ launchedAt: schema.sessionLaunches.launchedAt })
      .from(schema.sessionLaunches)
      .where(eq(schema.sessionLaunches.sessionId, sessionId))
      .limit(1);
    // A session started before launches were recorded has no row.
    return !launch || launch.launchedAt !== null;
  }

  /** A hosted session's state. The port is only asked about a workspace that can exist. */
  async function cloudStatus(session: Session): Promise<CloudSessionStatus | null> {
    if (session.kind !== "cloud") return null;
    if (session.status !== "active") {
      return {
        sessionId: session.id,
        state: "ended",
        error: null,
        updatedAt: session.endedAt ?? session.createdAt,
      };
    }
    if (!session.forkReadyAt || !(await launched(session.id))) {
      return {
        sessionId: session.id,
        state: "starting",
        error: null,
        updatedAt: session.forkReadyAt ?? session.createdAt,
      };
    }
    return cloudSessions.status(session.id);
  }

  async function view(session: Session): Promise<SessionView> {
    const usable = session.forkReadyAt !== null && session.forkDeletedAt === null;
    const [[repository], [change], fork, cloud] = await Promise.all([
      db
        .select()
        .from(schema.repositories)
        .where(eq(schema.repositories.id, session.repositoryId))
        .limit(1),
      db
        .select({
          id: schema.changes.id,
          number: schema.changes.number,
          title: schema.changes.title,
          status: schema.changes.status,
        })
        .from(schema.changes)
        .where(eq(schema.changes.sessionId, session.id))
        .limit(1),
      usable ? git.getRepo(session.forkRepo) : null,
      cloudStatus(session),
    ]);
    if (!repository) throw new ForgeError("not_found", "Repository not found");
    return {
      session,
      repository: { id: repository.id, slug: repository.slug },
      change: change ?? null,
      // Null until the fork is ready, and again once it has been deleted.
      pushRemote: fork?.remote ?? null,
      cloud,
    };
  }

  function authorize(ctx: ApiContext, action: Action): void {
    if (!can(ctx.user, action))
      throw new ForgeError("forbidden", "You are not allowed to do that.");
  }

  /** A hosted session the caller may drive, with a workspace to drive. */
  async function ownCloudSession(ctx: ApiContext, id: SessionId): Promise<Session> {
    const session = await sessionById(id);
    authorize(ctx, { type: "session.write", session });
    if (session.kind !== "cloud") {
      throw new ForgeError("invalid", "Only a cloud session has a hosted agent.");
    }
    if (!session.forkReadyAt) {
      throw new ForgeError("not_ready", "The session's fork is still being prepared.");
    }
    return session;
  }

  return {
    async start(ctx, input) {
      authorize(ctx, { type: "session.start" });
      const [row] = await db
        .select()
        .from(schema.repositories)
        .where(eq(schema.repositories.slug, input.repoSlug))
        .limit(1);
      if (!row) throw new ForgeError("not_found", "Repository not found");
      const session = await openSession(services, ctx.user, {
        repository: toRepository(row),
        kind: input.kind,
        title: input.title,
        prompt: input.prompt,
      });
      // A cloud session's prompt waits with it until the provisioning step
      // that completes the fork launches it.
      return view(session);
    },

    async get(ctx, input) {
      authorize(ctx, { type: "repository.read" });
      return view(await sessionById(input.sessionId));
    },

    async listMine(ctx) {
      const sessions = await db
        .select()
        .from(schema.sessions)
        .where(eq(schema.sessions.userId, ctx.user.id))
        .orderBy(desc(schema.sessions.createdAt));
      return Promise.all(sessions.map(view));
    },

    async prompt(ctx, input) {
      const session = await ownCloudSession(ctx, input.sessionId);
      await cloudSessions.prompt(session.id, input.text);
    },

    async events(ctx, input) {
      authorize(ctx, { type: "repository.read" });
      const session = await sessionById(input.sessionId);
      if (session.kind !== "cloud") return [];
      return cloudSessions.events(session.id, input.after);
    },

    async stop(ctx, input) {
      const session = await ownCloudSession(ctx, input.sessionId);
      await cloudSessions.stop(session.id);
      return view(session);
    },

    async abandon(ctx, input) {
      const session = await sessionById(input.sessionId);
      authorize(ctx, { type: "session.abandon", session });
      if (session.kind === "cloud" && session.forkReadyAt) await cloudSessions.stop(session.id);
      const [change] = await db
        .select({ id: schema.changes.id })
        .from(schema.changes)
        .where(eq(schema.changes.sessionId, session.id))
        .limit(1);
      // Closing a change ends its session; a session with no change is ended directly.
      if (change) await closeChange(services, ctx.user, change.id);
      else await endSession(services, session.id, "abandoned");
      return view(await sessionById(session.id));
    },
  };
}
