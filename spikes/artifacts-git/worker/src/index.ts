// GF-12 spike. Throwaway: one Worker that records Artifacts push events in a Workflow,
// writes to repositories with isomorphic-git, and reads them through the binding.
// Every route needs the `x-spike-key` header; the Worker refuses everything when the secret is unset.

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import git from "isomorphic-git";
import http from "isomorphic-git/http/web";
import { MemoryFS } from "./memfs";

interface Env {
	ARTIFACTS: Artifacts;
	PUSH_EVENTS: Workflow;
	SPIKE_KEY?: string;
}

const AUTHOR = { name: "gitflare-spike", email: "spike@example.com" };
const DIR = "/r";

export class PushEvents extends WorkflowEntrypoint<Env> {
	async run(event: WorkflowEvent<unknown>, step: WorkflowStep) {
		// The step output is what the README reads back through the Workflows REST API.
		return step.do("record", async () => JSON.parse(JSON.stringify(event)));
	}
}

type Phases = Record<string, number>;

// Date.now() only advances across I/O in Workers, so these are wall times per phase, not CPU.
async function timed<T>(phases: Phases, name: string, fn: () => Promise<T>): Promise<T> {
	const start = Date.now();
	try {
		return await fn();
	} finally {
		phases[name] = Date.now() - start;
	}
}

async function access(env: Env, name: string, scope: "read" | "write") {
	const repo = await env.ARTIFACTS.get(name);
	const info = await repo.info();
	const token = await repo.createToken(scope, 300);
	const secret = token.plaintext.split("?expires=")[0];
	return { repo, info, token, onAuth: () => ({ username: "x", password: secret }) };
}

// Replaces one file by rewriting only the trees on its path. Works on a clone with no checkout.
async function writePath(fs: MemoryFS, treeOid: string | undefined, parts: string[], blobOid: string): Promise<string> {
	const tree = treeOid ? (await git.readTree({ fs, dir: DIR, oid: treeOid })).tree : [];
	const [head, ...rest] = parts;
	const entries = tree.filter((entry) => entry.path !== head);
	if (rest.length === 0) {
		entries.push({ mode: "100644", path: head, oid: blobOid, type: "blob" });
	} else {
		const existing = tree.find((entry) => entry.path === head && entry.type === "tree");
		entries.push({ mode: "040000", path: head, oid: await writePath(fs, existing?.oid, rest, blobOid), type: "tree" });
	}
	return git.writeTree({ fs, dir: DIR, tree: entries });
}

// POST /iso/commit { repo, path, content, depth?, mode?: "checkout" | "plumbing" }
async function isoCommit(env: Env, p: { repo: string; path: string; content: string; depth?: number; mode?: string }) {
	const phases: Phases = {};
	const fs = new MemoryFS();
	const mode = p.mode ?? "checkout";
	const { info, onAuth } = await timed(phases, "token", () => access(env, p.repo, "write"));
	const branch = info.defaultBranch;

	await timed(phases, "clone", () =>
		git.clone({
			fs,
			http,
			dir: DIR,
			url: info.remote,
			ref: branch,
			singleBranch: true,
			noTags: true,
			depth: p.depth === 0 ? undefined : (p.depth ?? 1),
			noCheckout: mode === "plumbing",
			onAuth,
		}),
	);
	const afterClone = fs.usage();

	let oid: string;
	if (mode === "plumbing") {
		oid = await timed(phases, "commit", async () => {
			const parent = await git.resolveRef({ fs, dir: DIR, ref: branch });
			const { commit } = await git.readCommit({ fs, dir: DIR, oid: parent });
			const blob = await git.writeBlob({ fs, dir: DIR, blob: new TextEncoder().encode(p.content) });
			const tree = await writePath(fs, commit.tree, p.path.split("/"), blob);
			const now = Math.floor(Date.now() / 1000);
			const who = { ...AUTHOR, timestamp: now, timezoneOffset: 0 };
			const created = await git.writeCommit({
				fs,
				dir: DIR,
				commit: { message: `spike: write ${p.path} (plumbing)\n`, tree, parent: [parent], author: who, committer: who },
			});
			await git.writeRef({ fs, dir: DIR, ref: `refs/heads/${branch}`, value: created, force: true });
			return created;
		});
	} else {
		oid = await timed(phases, "commit", async () => {
			const parts = p.path.split("/");
			for (let i = 1; i < parts.length; i++) {
				await fs.promises.mkdir(`${DIR}/${parts.slice(0, i).join("/")}`).catch(() => {});
			}
			await fs.promises.writeFile(`${DIR}/${p.path}`, p.content);
			await git.add({ fs, dir: DIR, filepath: p.path });
			return git.commit({ fs, dir: DIR, message: `spike: write ${p.path} (checkout)`, author: AUTHOR });
		});
	}

	const push = await timed(phases, "push", () => git.push({ fs, http, dir: DIR, url: info.remote, ref: branch, onAuth }));
	return { mode, oid, push, phases, afterClone, atEnd: fs.usage() };
}

// POST /iso/merge { parent, fork, branch?, depth?, fastForward?, checkout? }
async function isoMerge(
	env: Env,
	p: { parent: string; fork: string; branch?: string; depth?: number; fastForward?: boolean; checkout?: boolean },
) {
	const phases: Phases = {};
	const fs = new MemoryFS();
	const [parent, fork] = await timed(phases, "token", () =>
		Promise.all([access(env, p.parent, "write"), access(env, p.fork, "read")]),
	);
	const ours = parent.info.defaultBranch;
	const theirs = p.branch ?? fork.info.defaultBranch;
	const depth = p.depth === 0 ? undefined : p.depth;

	await timed(phases, "clone", () =>
		git.clone({
			fs,
			http,
			dir: DIR,
			url: parent.info.remote,
			ref: ours,
			singleBranch: true,
			noTags: true,
			depth,
			noCheckout: !p.checkout,
			onAuth: parent.onAuth,
		}),
	);
	const afterClone = fs.usage();

	await git.addRemote({ fs, dir: DIR, remote: "fork", url: fork.info.remote });
	const fetched = await timed(phases, "fetchFork", () =>
		git.fetch({ fs, http, dir: DIR, remote: "fork", ref: theirs, singleBranch: true, tags: false, depth, onAuth: fork.onAuth }),
	);

	const merge = await timed(phases, "merge", () =>
		git.merge({
			fs,
			dir: DIR,
			ours,
			theirs: `refs/remotes/fork/${theirs}`,
			fastForward: p.fastForward ?? true,
			abortOnConflict: true,
			author: AUTHOR,
			message: `Merge ${p.fork}:${theirs} into ${ours}`,
		}),
	);

	const push = await timed(phases, "push", () =>
		git.push({ fs, http, dir: DIR, url: parent.info.remote, ref: ours, onAuth: parent.onAuth }),
	);
	return { fetched: { fetchHead: fetched.fetchHead }, merge, push, phases, afterClone, atEnd: fs.usage() };
}

function pktLine(text: string) {
	const bytes = new TextEncoder().encode(text);
	const length = (bytes.byteLength + 4).toString(16).padStart(4, "0");
	return new Uint8Array([...new TextEncoder().encode(length), ...bytes]);
}

function gitMode(mode: string) {
	return mode === "40000" ? "040000" : mode;
}

function gitType(type: string): "blob" | "tree" | "commit" {
	if (type === "tree") return "tree";
	return type === "gitlink" ? "commit" : "blob";
}

// POST /thin/commit { repo, path, content }
// No clone at all: read the trees on the path through the binding, build the new blob, trees and
// commit locally, and send a pack holding only those objects straight to git-receive-pack.
async function thinCommit(env: Env, p: { repo: string; path: string; content: string }) {
	const phases: Phases = {};
	const fs = new MemoryFS();
	const { repo, info, token } = await timed(phases, "token", () => access(env, p.repo, "write"));
	const ref = `refs/heads/${info.defaultBranch}`;
	await git.init({ fs, dir: DIR, defaultBranch: info.defaultBranch });
	const created: string[] = [];
	let bindingReads = 0;

	const rewrite = async (treeHash: string | undefined, parts: string[], blobOid: string): Promise<string> => {
		bindingReads++;
		const tree = treeHash ? ((await repo.readTree(treeHash)) ?? []) : [];
		const [head, ...rest] = parts;
		const entries = tree
			.filter((entry) => entry.name !== head)
			.map((entry) => ({ mode: gitMode(entry.mode), path: entry.name, oid: entry.hash, type: gitType(entry.type) }));
		if (rest.length === 0) {
			entries.push({ mode: "100644", path: head, oid: blobOid, type: "blob" });
		} else {
			const existing = tree.find((entry) => entry.name === head && entry.type === "tree");
			entries.push({ mode: "040000", path: head, oid: await rewrite(existing?.hash, rest, blobOid), type: "tree" });
		}
		const oid = await git.writeTree({ fs, dir: DIR, tree: entries });
		created.push(oid);
		return oid;
	};

	const commitOid = await timed(phases, "build", async () => {
		const [head] = await repo.log({ ref: info.defaultBranch, limit: 1 });
		const blob = await git.writeBlob({ fs, dir: DIR, blob: new TextEncoder().encode(p.content) });
		created.push(blob);
		const tree = await rewrite(head.treeHash, p.path.split("/"), blob);
		const now = Math.floor(Date.now() / 1000);
		const who = { ...AUTHOR, timestamp: now, timezoneOffset: 0 };
		const oid = await git.writeCommit({
			fs,
			dir: DIR,
			commit: { message: `spike: write ${p.path} (thin pack, no clone)\n`, tree, parent: [head.hash], author: who, committer: who },
		});
		created.push(oid);
		return { oid, old: head.hash };
	});

	const pack = await timed(phases, "pack", () => git.packObjects({ fs, dir: DIR, oids: created }));
	const command = pktLine(`${commitOid.old} ${commitOid.oid} ${ref}\0 report-status agent=gitflare-spike\n`);
	const body = new Uint8Array([...command, ...new TextEncoder().encode("0000"), ...pack.packfile!]);
	const response = await timed(phases, "push", () =>
		fetch(`${info.remote}/git-receive-pack`, {
			method: "POST",
			headers: {
				authorization: `Bearer ${token.plaintext}`,
				"content-type": "application/x-git-receive-pack-request",
				accept: "application/x-git-receive-pack-result",
			},
			body,
		}),
	);
	return {
		oid: commitOid.oid,
		old: commitOid.old,
		objects: created.length,
		packBytes: pack.packfile!.byteLength,
		bindingReads,
		status: response.status,
		report: await response.text(),
		phases,
	};
}

async function describeBlob(blob: Blob | null) {
	if (!blob) return null;
	const text = await blob.text();
	return { constructor: blob.constructor.name, type: blob.type, size: blob.size, head: text.slice(0, 80) };
}

async function attempt<T>(fn: () => Promise<T>) {
	try {
		return await fn();
	} catch (error) {
		const e = error as Error & { code?: string; numericCode?: number };
		return { threw: { name: e.name, code: e.code, numericCode: e.numericCode, message: e.message } };
	}
}

// POST /binding/shapes { repo, file, refs?: string[] }
async function bindingShapes(env: Env, p: { repo: string; file: string; refs?: string[] }) {
	const repo = await env.ARTIFACTS.get(p.repo);
	const info = await repo.info();
	const log = await repo.log({ ref: info.defaultBranch, limit: 3 });
	const head = log[0];
	const tree = head ? await repo.readTree(head.treeHash) : null;
	const firstBlob = tree?.find((entry) => entry.type === "blob");
	return {
		info,
		log,
		logOffset: await attempt(() => repo.log({ ref: info.defaultBranch, limit: 1, offset: 1 })),
		readCommit: head ? await repo.readCommit(head.hash) : null,
		readTree: tree,
		readFile: await attempt(async () => describeBlob(await repo.readFile({ ref: info.defaultBranch, path: p.file }))),
		readBlob: firstBlob ? await describeBlob(await repo.readBlob(firstBlob.hash)) : null,
		listTokens: await attempt(() => repo.listTokens()),
		edge: {
			readFileMissing: await attempt(() => repo.readFile({ ref: info.defaultBranch, path: "does/not/exist" })),
			readFileDirectory: await attempt(() => repo.readFile({ ref: info.defaultBranch, path: p.file.split("/")[0] })),
			readFileByCommit: head
				? await attempt(async () => describeBlob(await repo.readFile({ ref: head.hash, path: p.file })))
				: null,
			readTreeOfCommitHash: head ? await attempt(() => repo.readTree(head.hash)) : null,
			readCommitShortHash: head ? await attempt(() => repo.readCommit(head.hash.slice(0, 7))) : null,
			readCommitUnknown: await attempt(() => repo.readCommit("0".repeat(40))),
			logUnknownRef: await attempt(() => repo.log({ ref: "refs/heads/nope" })),
			logByRef: Object.fromEntries(
				await Promise.all(
					(p.refs ?? []).map(async (ref) => [
						ref,
						await attempt(async () => (await repo.log({ ref, limit: 2 })).map((c) => `${c.hash} ${c.message}`)),
					]),
				),
			),
		},
	};
}

// POST /binding/diff { repo, base, head, blobs?: boolean }
// Changed paths between two commits from readTree alone; `blobs` also loads both sides of each change.
async function bindingDiff(env: Env, p: { repo: string; base: string; head: string; blobs?: boolean }) {
	const started = Date.now();
	const repo = await env.ARTIFACTS.get(p.repo);
	const calls = { readCommit: 0, readTree: 0, readBlob: 0 };
	const changes: { path: string; status: string; old?: string; new?: string }[] = [];

	const readTree = async (hash?: string) => {
		if (!hash) return [];
		calls.readTree++;
		return (await repo.readTree(hash)) ?? [];
	};

	const walk = async (prefix: string, oldHash?: string, newHash?: string): Promise<void> => {
		const [oldTree, newTree] = await Promise.all([readTree(oldHash), readTree(newHash)]);
		const before = new Map(oldTree.map((entry) => [entry.name, entry]));
		const after = new Map(newTree.map((entry) => [entry.name, entry]));
		const pending: Promise<void>[] = [];
		for (const name of new Set([...before.keys(), ...after.keys()])) {
			const a = before.get(name);
			const b = after.get(name);
			if (a?.hash === b?.hash && a?.mode === b?.mode) continue;
			const path = prefix + name;
			const aTree = a?.type === "tree";
			const bTree = b?.type === "tree";
			if (aTree || bTree) pending.push(walk(`${path}/`, aTree ? a.hash : undefined, bTree ? b.hash : undefined));
			if (a && !aTree && b && !bTree) changes.push({ path, status: "modified", old: a.hash, new: b.hash });
			else {
				if (a && !aTree) changes.push({ path, status: "deleted", old: a.hash });
				if (b && !bTree) changes.push({ path, status: "added", new: b.hash });
			}
		}
		await Promise.all(pending);
	};

	calls.readCommit += 2;
	const [base, head] = await Promise.all([repo.readCommit(p.base), repo.readCommit(p.head)]);
	if (!base || !head) return { error: "commit not found", base, head };
	await walk("", base.treeHash, head.treeHash);
	const treesMs = Date.now() - started;

	let blobBytes = 0;
	if (p.blobs) {
		const hashes = changes.flatMap((change) => [change.old, change.new]).filter((hash): hash is string => Boolean(hash));
		const sizes = await Promise.all(
			hashes.map(async (hash) => {
				calls.readBlob++;
				return (await repo.readBlob(hash))?.size ?? 0;
			}),
		);
		blobBytes = sizes.reduce((sum, size) => sum + size, 0);
	}

	changes.sort((x, y) => x.path.localeCompare(y.path));
	return { calls, treesMs, totalMs: Date.now() - started, blobBytes, changed: changes.length, changes: changes.slice(0, 40) };
}

// POST /relay/ff { parent, fork, branch }
// Fast-forward with no clone: ask the fork's upload-pack for exactly the objects the parent lacks
// (want = fork tip, have = parent tip) and hand that pack to the parent's receive-pack unchanged.
async function relayFastForward(env: Env, p: { parent: string; fork: string; branch: string }) {
	const phases: Phases = {};
	const [parent, fork] = await timed(phases, "token", () =>
		Promise.all([access(env, p.parent, "write"), access(env, p.fork, "read")]),
	);
	const ref = `refs/heads/${parent.info.defaultBranch}`;
	const [[parentTip], forkLog] = await timed(phases, "tips", () =>
		Promise.all([parent.repo.log({ ref: parent.info.defaultBranch, limit: 1 }), fork.repo.log({ ref: p.branch, limit: 1000 })]),
	);
	const forkTip = forkLog[0];
	// log() is first-parent only, so this misses ancestry through a merge's second parent.
	if (!forkLog.some((commit) => commit.hash === parentTip.hash)) {
		return { fastForward: false, reason: "parent tip is not on the fork branch's first-parent chain" };
	}

	const want = new Uint8Array([
		...pktLine(`want ${forkTip.hash} ofs-delta agent=gitflare-spike\n`),
		...new TextEncoder().encode("0000"),
		...pktLine(`have ${parentTip.hash}\n`),
		...pktLine("done\n"),
	]);
	const upload = await timed(phases, "uploadPack", async () => {
		const response = await fetch(`${fork.info.remote}/git-upload-pack`, {
			method: "POST",
			headers: {
				authorization: `Bearer ${fork.token.plaintext}`,
				"content-type": "application/x-git-upload-pack-request",
				accept: "application/x-git-upload-pack-result",
			},
			body: want,
		});
		return { status: response.status, bytes: new Uint8Array(await response.arrayBuffer()) };
	});

	// Without side-band the reply is ACK/NAK pkt-lines followed by the raw pack.
	let offset = 0;
	const preamble: string[] = [];
	const decoder = new TextDecoder();
	while (decoder.decode(upload.bytes.subarray(offset, offset + 4)) !== "PACK" && offset < upload.bytes.byteLength) {
		const length = Number.parseInt(decoder.decode(upload.bytes.subarray(offset, offset + 4)), 16);
		if (!Number.isFinite(length) || length < 4) break;
		preamble.push(decoder.decode(upload.bytes.subarray(offset + 4, offset + length)).trim());
		offset += length;
	}
	let pack = upload.bytes.subarray(offset);
	// Observed 2026-10-02: Artifacts ends the non-side-band reply with a flush-pkt ("0000") after the
	// pack's SHA-1 trailer, and its own receive-pack answers 500 if that is passed along.
	const trailingFlush = decoder.decode(pack.subarray(pack.byteLength - 4)) === "0000";
	if (trailingFlush) pack = pack.subarray(0, pack.byteLength - 4);
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-1", pack.subarray(0, pack.byteLength - 20)));
	const trailerValid = digest.every((byte, index) => byte === pack[pack.byteLength - 20 + index]);
	if (decoder.decode(pack.subarray(0, 4)) !== "PACK" || !trailerValid) {
		return { error: "no valid pack in upload-pack reply", status: upload.status, preamble, trailerValid, head: decoder.decode(upload.bytes.subarray(0, 200)) };
	}
	const objects = new DataView(pack.buffer, pack.byteOffset + 8, 4).getUint32(0);

	const command = pktLine(`${parentTip.hash} ${forkTip.hash} ${ref}\0 report-status agent=gitflare-spike\n`);
	const receive = await timed(phases, "receivePack", async () => {
		const response = await fetch(`${parent.info.remote}/git-receive-pack`, {
			method: "POST",
			headers: {
				authorization: `Bearer ${parent.token.plaintext}`,
				"content-type": "application/x-git-receive-pack-request",
				accept: "application/x-git-receive-pack-result",
			},
			body: new Uint8Array([...command, ...new TextEncoder().encode("0000"), ...pack]),
		});
		return { status: response.status, report: await response.text() };
	});
	return { fastForward: true, old: parentTip.hash, new: forkTip.hash, preamble, trailingFlush, packBytes: pack.byteLength, objects, receive, phases };
}

// POST /binding/fork { repo, name, defaultBranchOnly? }
async function bindingFork(env: Env, p: { repo: string; name: string; defaultBranchOnly?: boolean }) {
	const started = Date.now();
	const repo = await env.ARTIFACTS.get(p.repo);
	const options = p.defaultBranchOnly === undefined ? undefined : { defaultBranchOnly: p.defaultBranchOnly };
	const created = await repo.fork(p.name, options);
	const forkMs = Date.now() - started;
	const immediately = await attempt(async () => (await env.ARTIFACTS.get(p.name)).info());
	return { forkMs, created: { ...created, token: "<redacted>" }, immediately };
}

const routes: Record<string, (env: Env, body: never) => Promise<unknown>> = {
	"/binding/fork": bindingFork,
	"/relay/ff": relayFastForward,
	"/iso/commit": isoCommit,
	"/iso/merge": isoMerge,
	"/thin/commit": thinCommit,
	"/binding/shapes": bindingShapes,
	"/binding/diff": bindingDiff,
};

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		if (!env.SPIKE_KEY || request.headers.get("x-spike-key") !== env.SPIKE_KEY) {
			return new Response("forbidden", { status: 403 });
		}
		const route = routes[new URL(request.url).pathname];
		if (!route || request.method !== "POST") return new Response("not found", { status: 404 });
		const started = Date.now();
		try {
			const result = await route(env, (await request.json()) as never);
			return Response.json({ ok: true, wallMs: Date.now() - started, result });
		} catch (error) {
			const e = error as Error & { code?: string; data?: unknown };
			return Response.json(
				{ ok: false, wallMs: Date.now() - started, error: { name: e.name, code: e.code, message: e.message, data: e.data } },
				{ status: 500 },
			);
		}
	},
} satisfies ExportedHandler<Env>;
