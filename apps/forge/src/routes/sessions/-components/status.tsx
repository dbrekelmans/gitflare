import type { SessionView } from "@gitflare/core/api";
import { StatusPill } from "@gitflare/ui/components/status";
import { cloudStateCopy, sessionStatusCopy } from "./copy";

/** What the owner, and everyone else, reads as the session's state. */
export function sessionStatusLabel({ session, cloud }: Pick<SessionView, "session" | "cloud">) {
  if (!session.forkReadyAt && session.status === "active") return "preparing";
  if (session.status === "active" && cloud) return cloudStateCopy[cloud.state].label.toLowerCase();
  return session.status;
}

/**
 * The fork being prepared outranks everything else; then, while the session
 * is still active, a cloud session's own reported state; once the session
 * has ended (merged or abandoned) its own status is authoritative, since a
 * hosted agent's last reported state is no longer being kept current.
 */
export function SessionStatus({ session, cloud }: Pick<SessionView, "session" | "cloud">) {
  if (!session.forkReadyAt && session.status === "active") {
    return <StatusPill tone="neutral">Preparing</StatusPill>;
  }
  if (session.status === "active" && cloud) {
    const copy = cloudStateCopy[cloud.state];
    return <StatusPill tone={copy.tone}>{copy.label}</StatusPill>;
  }
  return <StatusPill tone={sessionStatusCopy[session.status]}>{session.status}</StatusPill>;
}
