import { idPrefixes, type SessionId } from "../ids";

/**
 * Repository names inside the deployment's Artifacts namespace.
 *
 *   <slug>                 the main repo; only gitflare holds a write token
 *   <slug>.context         its sibling: checkpoints and decision files
 *   <slug>.fork.<session>  one fork per session; its owner holds a write token
 *
 * A push event names only the repo, never who pushed. The fork's name is
 * therefore what ties a push to a session and, through it, to a user.
 */
const CONTEXT_SUFFIX = ".context";
const FORK_INFIX = ".fork.";

export function mainRepoName(slug: string): string {
  return slug;
}

export function contextRepoName(slug: string): string {
  return `${slug}${CONTEXT_SUFFIX}`;
}

export function forkRepoName(slug: string, sessionId: SessionId): string {
  return `${slug}${FORK_INFIX}${sessionId.slice(idPrefixes.session.length + 1)}`;
}

export type RepoNameKind =
  | { kind: "main"; slug: string }
  | { kind: "context"; slug: string }
  | { kind: "fork"; slug: string; sessionId: SessionId };

/** Slugs contain no dots, so the first dot always starts gitflare's own suffix. */
export function parseRepoName(name: string): RepoNameKind | null {
  const dot = name.indexOf(".");
  if (dot === -1) return name.length > 0 ? { kind: "main", slug: name } : null;
  const slug = name.slice(0, dot);
  const rest = name.slice(dot);
  if (slug.length === 0) return null;
  if (rest === CONTEXT_SUFFIX) return { kind: "context", slug };
  if (rest.startsWith(FORK_INFIX) && rest.length > FORK_INFIX.length) {
    return {
      kind: "fork",
      slug,
      sessionId: `${idPrefixes.session}_${rest.slice(FORK_INFIX.length)}`,
    };
  }
  return null;
}
