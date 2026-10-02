import { ForgeError, type Sha } from "@gitflare/core";

// Git's smart HTTP protocol, as far as the Worker speaks it by hand: one
// `git-receive-pack` request to move a ref with a pack, and one
// `git-upload-pack` request to be given a pack. Both are what was run against
// a live account in spec/research/live/artifacts-git.md, section 5.

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const FLUSH = encoder.encode("0000");
const AGENT = "agent=gitflare";

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/** A repository's git remote and a token for it. */
export interface RemoteAccess {
  /** `HostedRepo.remote`, exactly as the host returned it. */
  url: string;
  secret: string;
}

export function concatBytes(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

export function pktLine(text: string): Uint8Array {
  const payload = encoder.encode(text);
  const length = (payload.byteLength + 4).toString(16).padStart(4, "0");
  return concatBytes([encoder.encode(length), payload]);
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  return decoder.decode(bytes.subarray(start, end));
}

/** Reads pkt-lines from `offset` until a flush-pkt, the end, or something that is not a pkt-line. */
function readPktLines(bytes: Uint8Array, offset = 0): { lines: string[]; offset: number } {
  const lines: string[] = [];
  while (offset + 4 <= bytes.byteLength) {
    const header = ascii(bytes, offset, offset + 4);
    if (!/^[0-9a-f]{4}$/.test(header)) break;
    const length = Number.parseInt(header, 16);
    if (length === 0) {
      offset += 4;
      break;
    }
    if (length < 4 || offset + length > bytes.byteLength) break;
    lines.push(ascii(bytes, offset + 4, offset + length).replace(/\n$/, ""));
    offset += length;
  }
  return { lines, offset };
}

async function post(
  fetch: Fetch,
  remote: RemoteAccess,
  service: "git-upload-pack" | "git-receive-pack",
  body: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array> {
  const response = await fetch(`${remote.url}/${service}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${remote.secret}`,
      "content-type": `application/x-${service}-request`,
      accept: `application/x-${service}-result`,
    },
    body,
  });
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!response.ok) {
    throw new ForgeError(
      "unavailable",
      `${service} answered ${response.status}: ${ascii(bytes, 0, 200).trim()}`,
    );
  }
  return bytes;
}

/**
 * Moves `ref` from `old` to `new`, sending `pack` with it. The server compares
 * `old` with the ref's current value, so a concurrent writer is never
 * overwritten: its refusal is a `conflict`. It does not check that `new`
 * descends from `old`; the caller must.
 */
export async function receivePack(
  fetch: Fetch,
  remote: RemoteAccess,
  update: { ref: string; old: Sha; new: Sha },
  pack: Uint8Array,
): Promise<void> {
  const command = pktLine(`${update.old} ${update.new} ${update.ref}\0 report-status ${AGENT}\n`);
  const report = await post(fetch, remote, "git-receive-pack", concatBytes([command, FLUSH, pack]));
  const { lines } = readPktLines(report);
  const [unpack, ...statuses] = lines;
  if (unpack !== "unpack ok") {
    throw new ForgeError("unavailable", `the git host could not unpack the push: ${unpack ?? ""}`);
  }
  const status = statuses.find((line) => line.slice(3).startsWith(update.ref));
  if (status?.startsWith("ok ")) return;
  const reason = status?.slice(4 + update.ref.length) || "no status reported";
  // Artifacts reports a stale old value as `ng <ref> stale ref`; git itself
  // words a moved ref these other ways. Anything else is not a race to retry
  // against a newer tip.
  const moved =
    /stale|incorrect old value|non-fast-forward|fetch first|failed to lock|already exists/.test(
      reason,
    );
  throw new ForgeError(
    status && moved ? "conflict" : "unavailable",
    `${update.ref} was not updated: ${reason}`,
  );
}

/**
 * Asks for the pack of everything reachable from `want` that is not reachable
 * from `haves`. Without side-band the reply is ACK/NAK pkt-lines followed by
 * the raw pack, which is returned whole, checked against its own trailer.
 */
export async function uploadPack(
  fetch: Fetch,
  remote: RemoteAccess,
  request: { want: Sha; haves: Sha[] },
): Promise<Uint8Array> {
  const body = concatBytes([
    pktLine(`want ${request.want} ofs-delta ${AGENT}\n`),
    FLUSH,
    ...request.haves.map((have) => pktLine(`have ${have}\n`)),
    pktLine("done\n"),
  ]);
  const reply = await post(fetch, remote, "git-upload-pack", body);
  const { offset } = readPktLines(reply);
  const pack = await trimPack(reply.subarray(offset));
  if (!pack) throw new ForgeError("unavailable", "the git host's reply held no valid pack");
  return pack;
}

/**
 * How many bytes a clone of everything a public remote advertises would
 * download, counted as they arrive and never held. The count stops at
 * `limit`: a result above it means "too large", not a size.
 */
export async function measureRemote(fetch: Fetch, url: string, limit: number): Promise<number> {
  const base = url.replace(/\/+$/, "");
  const refs = await fetch(`${base}/info/refs?service=git-upload-pack`);
  if (!refs.ok) {
    // A remote that refuses to be read will refuse the import too.
    throw new ForgeError(
      refs.status >= 500 ? "unavailable" : "invalid",
      `${url} cannot be read: it answered ${refs.status}`,
    );
  }
  const advertisement = new Uint8Array(await refs.arrayBuffer());
  const service = readPktLines(advertisement);
  const tips = new Set<Sha>();
  for (const line of readPktLines(advertisement, service.offset).lines) {
    const [sha = "", name = ""] = (line.split("\0")[0] ?? "").split(" ");
    const wanted =
      name === "HEAD" || name.startsWith("refs/heads/") || name.startsWith("refs/tags/");
    if (wanted && !name.endsWith("^{}") && /^[0-9a-f]{40}$/.test(sha)) tips.add(sha);
  }
  if (tips.size === 0) return 0;

  const [first = "", ...rest] = [...tips];
  const response = await fetch(`${base}/git-upload-pack`, {
    method: "POST",
    headers: {
      "content-type": "application/x-git-upload-pack-request",
      accept: "application/x-git-upload-pack-result",
    },
    body: concatBytes([
      pktLine(`want ${first} no-progress ${AGENT}\n`),
      ...rest.map((sha) => pktLine(`want ${sha}\n`)),
      FLUSH,
      pktLine("done\n"),
    ]),
  });
  if (!response.ok || !response.body) {
    throw new ForgeError("unavailable", `${url} answered ${response.status} to a fetch`);
  }
  const reader = response.body.getReader();
  let size = 0;
  for (let read = await reader.read(); !read.done; read = await reader.read()) {
    size += read.value.byteLength;
    if (size > limit) {
      await reader.cancel();
      break;
    }
  }
  return size;
}

async function hasValidTrailer(pack: Uint8Array): Promise<boolean> {
  if (pack.byteLength < 32 || ascii(pack, 0, 4) !== "PACK") return false;
  // Hashed in place: a copy would hold a large pack twice.
  const body = pack.subarray(0, pack.byteLength - 20) as Uint8Array<ArrayBuffer>;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-1", body));
  const trailer = pack.subarray(pack.byteLength - 20);
  return digest.every((byte, index) => byte === trailer[index]);
}

/**
 * Artifacts ends a reply without side-band with a flush-pkt after the pack's
 * SHA-1 trailer, and its own receive-pack answers 500 when given those four
 * bytes. The trailer decides where the pack ends.
 */
export async function trimPack(bytes: Uint8Array): Promise<Uint8Array | null> {
  if (await hasValidTrailer(bytes)) return bytes;
  const trimmed = bytes.subarray(0, bytes.byteLength - 4);
  const flushed = ascii(bytes, Math.max(0, bytes.byteLength - 4), bytes.byteLength) === "0000";
  return flushed && (await hasValidTrailer(trimmed)) ? trimmed : null;
}
