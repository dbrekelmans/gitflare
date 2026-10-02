// An in-memory filesystem with the subset of `fs.promises` isomorphic-git
// calls. Errors carry `code`, which isomorphic-git branches on (ENOENT,
// EEXIST, ENOTEMPTY).

type Entry =
  | { kind: "dir"; children: Set<string>; mtimeMs: number }
  | { kind: "file"; data: Uint8Array; mtimeMs: number };

function fsError(code: string, path: string): Error {
  return Object.assign(new Error(`${code}: ${path}`), { code });
}

function normalize(input: string): string {
  const segments: string[] = [];
  for (const part of input.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") segments.pop();
    else segments.push(part);
  }
  return `/${segments.join("/")}`;
}

function split(path: string): { parent: string; name: string } {
  const at = path.lastIndexOf("/");
  return { parent: at <= 0 ? "/" : path.slice(0, at), name: path.slice(at + 1) };
}

function stats(entry: Entry) {
  const file = entry.kind === "file";
  return {
    type: file ? "file" : "dir",
    mode: file ? 0o100644 : 0o040000,
    size: file ? entry.data.byteLength : 0,
    ino: 0,
    uid: 0,
    gid: 0,
    dev: 0,
    mtimeMs: entry.mtimeMs,
    ctimeMs: entry.mtimeMs,
    isFile: () => file,
    isDirectory: () => !file,
    isSymbolicLink: () => false,
  };
}

export class MemoryFS {
  private readonly entries = new Map<string, Entry>([
    ["/", { kind: "dir", children: new Set(), mtimeMs: Date.now() }],
  ]);

  readonly promises = {
    readFile: async (path: string, options?: { encoding?: string } | string) => {
      const entry = this.entries.get(normalize(path));
      if (!entry) throw fsError("ENOENT", path);
      if (entry.kind !== "file") throw fsError("EISDIR", path);
      const encoding = typeof options === "string" ? options : options?.encoding;
      return encoding === "utf8" ? new TextDecoder().decode(entry.data) : entry.data;
    },
    writeFile: async (path: string, data: Uint8Array | string) => {
      const target = normalize(path);
      const { parent, name } = split(target);
      const dir = this.entries.get(parent);
      if (!dir) throw fsError("ENOENT", path);
      if (dir.kind !== "dir") throw fsError("ENOTDIR", path);
      const bytes =
        typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data);
      this.entries.set(target, { kind: "file", data: bytes, mtimeMs: Date.now() });
      dir.children.add(name);
    },
    unlink: async (path: string) => {
      const target = normalize(path);
      if (!this.entries.delete(target)) throw fsError("ENOENT", path);
      const { parent, name } = split(target);
      const dir = this.entries.get(parent);
      if (dir?.kind === "dir") dir.children.delete(name);
    },
    readdir: async (path: string) => {
      const entry = this.entries.get(normalize(path));
      if (!entry) throw fsError("ENOENT", path);
      if (entry.kind !== "dir") throw fsError("ENOTDIR", path);
      return [...entry.children].sort();
    },
    mkdir: async (path: string) => {
      const target = normalize(path);
      if (this.entries.has(target)) throw fsError("EEXIST", path);
      const { parent, name } = split(target);
      const dir = this.entries.get(parent);
      if (!dir) throw fsError("ENOENT", path);
      if (dir.kind !== "dir") throw fsError("ENOTDIR", path);
      this.entries.set(target, { kind: "dir", children: new Set(), mtimeMs: Date.now() });
      dir.children.add(name);
    },
    rmdir: async (path: string) => {
      const target = normalize(path);
      const entry = this.entries.get(target);
      if (!entry) throw fsError("ENOENT", path);
      if (entry.kind !== "dir") throw fsError("ENOTDIR", path);
      if (entry.children.size) throw fsError("ENOTEMPTY", path);
      this.entries.delete(target);
      const { parent, name } = split(target);
      const dir = this.entries.get(parent);
      if (dir?.kind === "dir") dir.children.delete(name);
    },
    stat: async (path: string) => {
      const entry = this.entries.get(normalize(path));
      if (!entry) throw fsError("ENOENT", path);
      return stats(entry);
    },
    lstat: async (path: string) => {
      const entry = this.entries.get(normalize(path));
      if (!entry) throw fsError("ENOENT", path);
      return stats(entry);
    },
    readlink: async (path: string) => {
      throw fsError("EINVAL", path);
    },
    symlink: async (_target: string, path: string) => {
      throw fsError("ENOSYS", path);
    },
    chmod: async () => {},
  };
}
