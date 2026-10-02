import type { Change } from "./change";
import type { User } from "./organisation";
import type { Session } from "./repository";

/**
 * Access decides who a person is; this decides what they may do. One
 * deployment is one organisation that trusts its members, so the rules are
 * few: administrators run the deployment, and a session belongs to whoever
 * started it.
 */
export type Action =
  | { type: "members.manage" }
  | { type: "settings.manage" }
  | { type: "repository.create" }
  | { type: "repository.read" }
  | { type: "session.start" }
  /** Receive a write token for the session's fork, or prompt its hosted agent. */
  | { type: "session.write"; session: Pick<Session, "userId" | "status"> }
  | { type: "session.abandon"; session: Pick<Session, "userId" | "status"> }
  | { type: "change.review" }
  | { type: "change.merge" }
  | { type: "change.close"; change: Pick<Change, "authorId"> }
  | { type: "decision.edit" };

export function can(user: Pick<User, "id" | "role">, action: Action): boolean {
  const admin = user.role === "admin";
  switch (action.type) {
    case "members.manage":
    case "settings.manage":
    case "repository.create":
      return admin;
    case "session.write":
      return action.session.status === "active" && action.session.userId === user.id;
    case "session.abandon":
      return action.session.status === "active" && (admin || action.session.userId === user.id);
    case "change.close":
      return admin || action.change.authorId === user.id;
    case "repository.read":
    case "session.start":
    case "change.review":
    case "change.merge":
    case "decision.edit":
      return true;
  }
}
