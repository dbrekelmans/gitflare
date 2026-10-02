import {
  can,
  ForgeError,
  type GitTokenGrant,
  parseRepoName,
  type SessionId,
  type User,
} from "@gitflare/core";
import type { GitCredential } from "@gitflare/core/api";
import { schema } from "@gitflare/db";
import { eq } from "drizzle-orm";
import { type ArtifactsDeps, repositoryBySlug } from "./deps";

type TokenDeps = Pick<ArtifactsDeps, "db" | "git" | "clock">;

/** Long enough for a clone of a large repository, short enough that a leaked one is soon worthless. */
const CREDENTIAL_TTL_SECONDS = 3600;
/** Gitflare's own tokens are used within the request or the Workflow step that minted them. */
const SYSTEM_TTL_SECONDS = 900;

function refuse(): never {
  throw new ForgeError("forbidden", "You may not use that git remote.");
}

/** `https://host/git/<namespace>/<repo>.git`, reduced to what identifies the repository. */
function remoteKey(remote: string): { key: string; name: string } | null {
  let url: URL;
  try {
    url = new URL(remote);
  } catch {
    return null;
  }
  const path = url.pathname.replace(/\/+$/, "").replace(/\.git$/, "");
  const name = path.split("/").at(-1);
  return name ? { key: `${url.origin}${path}`, name } : null;
}

/** Mints a token and records who it is for. A token that could not be recorded is revoked, never returned. */
async function mintRecorded(
  deps: TokenDeps,
  grant: Pick<GitTokenGrant, "repoName" | "userId" | "sessionId" | "scope" | "purpose">,
  ttlSeconds: number,
): Promise<{ secret: string; grant: GitTokenGrant }> {
  const token = await deps.git.mintToken(grant.repoName, grant.scope, ttlSeconds);
  const recorded: GitTokenGrant = {
    ...grant,
    tokenId: token.id,
    expiresAt: token.expiresAt,
    createdAt: deps.clock.now(),
    revokedAt: null,
  };
  try {
    await deps.db.insert(schema.gitTokens).values(recorded);
  } catch (error) {
    await deps.git.revokeToken(grant.repoName, token.id).catch(() => false);
    throw error;
  }
  return { secret: token.secret, grant: recorded };
}

/**
 * The credential for one git remote, for one user: read on a main repo, write
 * on the caller's own active session fork, write on a context repo. Mints a
 * short-lived token and records the grant. Refuses with `forbidden` otherwise.
 */
export async function issueGitCredential(
  deps: ArtifactsDeps,
  user: User,
  remote: string,
): Promise<GitCredential> {
  const asked = remoteKey(remote);
  const repo = asked ? parseRepoName(asked.name) : null;
  if (!asked || !repo) refuse();

  const repository = await repositoryBySlug(deps.db, repo.slug);
  if (!repository || repository.archivedAt) refuse();

  let grant: Pick<GitTokenGrant, "sessionId" | "scope" | "purpose">;
  if (repo.kind === "main") {
    if (!can(user, { type: "repository.read" })) refuse();
    // Never a write token: withholding it is the main repo's only protection.
    grant = { sessionId: null, scope: "read", purpose: "clone" };
  } else if (repo.kind === "context") {
    if (!can(user, { type: "repository.read" })) refuse();
    grant = { sessionId: null, scope: "write", purpose: "checkpoint_push" };
  } else {
    const [session] = await deps.db
      .select()
      .from(schema.sessions)
      .where(eq(schema.sessions.id, repo.sessionId))
      .limit(1);
    if (!session || session.forkRepo !== asked.name) refuse();
    if (!can(user, { type: "session.write", session })) refuse();
    if (!session.forkReadyAt) {
      throw new ForgeError("not_ready", "The session's fork is still being prepared.");
    }
    grant = { sessionId: session.id, scope: "write", purpose: "session_push" };
  }

  // Git sends the password to whatever host the remote names. A token is only
  // issued for the remote the host itself reports for that repository.
  const hosted = await deps.git.getRepo(asked.name);
  if (!hosted || remoteKey(hosted.remote)?.key !== asked.key) refuse();
  if (hosted.status !== "ready") {
    throw new ForgeError("not_ready", `${asked.name} is still being copied.`);
  }

  const minted = await mintRecorded(
    deps,
    { ...grant, repoName: asked.name, userId: user.id },
    CREDENTIAL_TTL_SECONDS,
  );
  return { username: "gitflare", password: minted.secret, expiresAt: minted.grant.expiresAt };
}

/** A token for gitflare's own use, recorded like any other. */
export async function mintSystemToken(
  deps: TokenDeps,
  repoName: string,
  scope: GitTokenGrant["scope"],
  purpose: GitTokenGrant["purpose"],
): Promise<{ secret: string; grant: GitTokenGrant }> {
  const repo = parseRepoName(repoName);
  const sessionId: SessionId | null = repo?.kind === "fork" ? repo.sessionId : null;
  return mintRecorded(
    deps,
    { repoName, userId: null, sessionId, scope, purpose },
    SYSTEM_TTL_SECONDS,
  );
}
