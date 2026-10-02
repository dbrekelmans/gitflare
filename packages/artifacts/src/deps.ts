import { ForgeError, type GitSignature, type Repository, type Session } from "@gitflare/core";
import type {
  CapturePort,
  Clock,
  GitHost,
  GitWriter,
  IdGenerator,
  Provisioner,
} from "@gitflare/core/ports";
import { type Db, schema, toRepository } from "@gitflare/db";
import { eq } from "drizzle-orm";
import type { Fetch } from "./wire";

export interface ArtifactsDeps {
  db: Db;
  git: GitHost;
  gitWriter: GitWriter;
  /** For the capture settings files committed to a new repository. */
  capture: CapturePort;
  /** Forks and imports are started here and finished by the provisioning Workflow. */
  provisioning: Provisioner;
  clock: Clock;
  ids: IdGenerator;
  /** Reaches the source of an import, to measure it. Defaults to the global `fetch`. */
  fetch?: Fetch;
  /** The most an import's source may weigh. Defaults to the host's limit per repository. */
  maxImportBytes?: number;
}

/** Who gitflare's own commits are by. */
export const systemAuthor: GitSignature = { name: "gitflare", email: "gitflare@noreply.invalid" };

export async function repositoryById(db: Db, id: Repository["id"]): Promise<Repository> {
  const [row] = await db
    .select()
    .from(schema.repositories)
    .where(eq(schema.repositories.id, id))
    .limit(1);
  if (!row) throw new ForgeError("not_found", "Repository not found");
  return toRepository(row);
}

export async function repositoryBySlug(db: Db, slug: string): Promise<Repository | null> {
  const [row] = await db
    .select()
    .from(schema.repositories)
    .where(eq(schema.repositories.slug, slug))
    .limit(1);
  return row ? toRepository(row) : null;
}

export async function sessionById(db: Db, id: Session["id"]): Promise<Session> {
  const [row] = await db.select().from(schema.sessions).where(eq(schema.sessions.id, id)).limit(1);
  if (!row) throw new ForgeError("not_found", "Session not found");
  return row;
}
