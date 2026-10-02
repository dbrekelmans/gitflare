import type { Attribution, CapturedSession, ChangeId, Sha } from "@gitflare/core";
import type { GitHost, TreeEntry } from "@gitflare/core/ports";
import { parseCompactLines, parseFullLines, splitLines } from "./transcript";

// Reading a checkpoint tree: `metadata.json` at the root names each session's
// files, by path from the commit's tree root (`sessions-and-checkpoints.md`,
// spec/research/entire-capture.md). Both checkpoint id shapes (ULID and
// legacy hex) land here the same way, because the settings gitflare commits
// always select the `git-refs` backend: there is no legacy branch to read.

const decoder = new TextDecoder();

interface SessionFilePaths {
  metadata: string;
  transcript?: string;
  compact_transcript?: string;
  prompt?: string;
}

interface CheckpointSummary {
  checkpoint_id?: string;
  sessions?: SessionFilePaths[];
}

interface RawAttribution {
  agent_lines: number;
  agent_removed: number;
  human_added: number;
  human_modified: number;
  human_removed: number;
  agent_percentage: number;
}

interface SessionMetadata {
  checkpoint_id?: string;
  session_id: string;
  agent?: string;
  model?: string;
  checkpoint_transcript_start?: number;
  compact_transcript_start?: number;
  initial_attribution?: RawAttribution;
}

/** Entire's registry name (what `transcript.jsonl` lines carry) by display name, for the `full.jsonl` fallback. */
const AGENT_DISPLAY_TO_REGISTRY: Record<string, string> = {
  Antigravity: "antigravity",
  "Claude Code": "claude-code",
  Codex: "codex",
  "Copilot CLI": "copilot-cli",
  Cursor: "cursor",
  "Factory AI Droid": "factoryai-droid",
  OpenCode: "opencode",
  Pi: "pi",
};

function findEntry(entries: readonly TreeEntry[], name: string): TreeEntry | undefined {
  return entries.find((entry) => entry.name === name);
}

async function readJson<T>(
  git: Pick<GitHost, "readBlob">,
  repo: string,
  sha: Sha,
): Promise<T | null> {
  const bytes = await git.readBlob(repo, sha);
  if (!bytes) return null;
  try {
    return JSON.parse(decoder.decode(bytes)) as T;
  } catch {
    return null;
  }
}

/** The directory a session's files live in, from a root-relative path like `/0/metadata.json`. */
function sessionDir(path: string): string {
  const parts = path.replace(/^\//, "").split("/");
  parts.pop();
  return parts.join("/");
}

/** Reads `baseName` plus any numbered chunks (`baseName.001`, …) and joins them, as Entire's own chunking does. */
async function readChunked(
  git: Pick<GitHost, "readBlob">,
  repo: string,
  dirEntries: readonly TreeEntry[],
  baseName: string,
): Promise<string | null> {
  const chunkPattern = new RegExp(`^${baseName}(?:\\.(\\d+))?$`);
  const chunks = dirEntries
    .filter((entry) => entry.type === "blob" && chunkPattern.test(entry.name))
    .map((entry) => ({
      entry,
      n: entry.name === baseName ? 0 : Number(entry.name.slice(baseName.length + 1)),
    }))
    .sort((a, b) => a.n - b.n);
  if (chunks.length === 0) return null;
  const parts: string[] = [];
  for (const { entry } of chunks) {
    const bytes = await git.readBlob(repo, entry.sha);
    if (bytes) parts.push(decoder.decode(bytes));
  }
  return parts.join("\n");
}

function toAttribution(raw: RawAttribution | undefined): Attribution | null {
  if (!raw) return null;
  return {
    agentLines: raw.agent_lines + raw.agent_removed,
    humanLines: raw.human_added + raw.human_modified + raw.human_removed,
    agentPercentage: raw.agent_percentage,
  };
}

/**
 * A checkpoint ref's tree, read at one commit: every session it holds, sliced
 * to its own data. Null means the tip itself could not be read (the commit,
 * its tree, or the root `metadata.json` is missing) — a caller that already
 * knows the checkpoint's id should treat that as the checkpoint being
 * missing, not as a checkpoint with zero sessions.
 */
export async function readCheckpointTree(
  deps: { git: GitHost },
  contextRepo: string,
  tipSha: Sha,
  /** Falls back to this when the root or a session's own metadata names no checkpoint id. */
  knownCheckpointId?: string,
): Promise<CapturedSession[] | null> {
  const commit = await deps.git.readCommit(contextRepo, tipSha);
  if (!commit) return null;
  const rootEntries = (await deps.git.readTree(contextRepo, commit.treeSha)) ?? [];
  const rootMetaEntry = findEntry(rootEntries, "metadata.json");
  if (!rootMetaEntry) return null;
  const rootMeta = await readJson<CheckpointSummary>(deps.git, contextRepo, rootMetaEntry.sha);
  if (!rootMeta) return null;

  const sessions: CapturedSession[] = [];
  for (const paths of rootMeta.sessions ?? []) {
    const dir = sessionDir(paths.metadata);
    const dirEntry = findEntry(rootEntries, dir);
    if (dirEntry?.type !== "tree") continue;
    const dirEntries = (await deps.git.readTree(contextRepo, dirEntry.sha)) ?? [];
    const metaEntry = findEntry(dirEntries, "metadata.json");
    if (!metaEntry) continue;
    const meta = await readJson<SessionMetadata>(deps.git, contextRepo, metaEntry.sha);
    if (!meta) continue;

    let turns: CapturedSession["turns"] = [];
    let agent = meta.agent ? (AGENT_DISPLAY_TO_REGISTRY[meta.agent] ?? meta.agent) : "";

    // Prefer the compact transcript when it is actually there; a trailer
    // naming `compact_transcript` does not guarantee compaction succeeded
    // ("best-effort... omitted when compaction fails"), so fall back to the
    // native transcript rather than yielding no turns at all.
    const compactText = paths.compact_transcript
      ? await readChunked(deps.git, contextRepo, dirEntries, "transcript.jsonl")
      : null;
    if (compactText) {
      const lines = splitLines(compactText).slice(meta.compact_transcript_start ?? 0);
      const parsed = parseCompactLines(lines);
      turns = parsed.turns;
      if (parsed.agent) agent = parsed.agent;
    } else {
      const fullText = await readChunked(deps.git, contextRepo, dirEntries, "full.jsonl");
      if (fullText) {
        const lines = splitLines(fullText).slice(meta.checkpoint_transcript_start ?? 0);
        turns = parseFullLines(lines);
      }
    }

    sessions.push({
      // The caller knows the real change; a checkpoint tree does not.
      changeId: "" as ChangeId,
      agentSessionId: meta.session_id,
      agent,
      model: meta.model ?? null,
      checkpointIds: [meta.checkpoint_id ?? rootMeta.checkpoint_id ?? knownCheckpointId ?? ""],
      turns,
      attribution: toAttribution(meta.initial_attribution),
    });
  }
  return sessions;
}
