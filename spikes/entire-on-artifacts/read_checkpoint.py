#!/usr/bin/env python3
"""Trailer -> transcript, from a bare clone of the checkpoint repository alone.

usage: git -C <code-clone> log -1 --format=%B <sha> | read_checkpoint.py <bare-checkpoint-repo>

Follows the five steps in spec/research/entire-capture.md ("From a commit trailer to
the transcript") and prints what it finds, so the note can be checked against real data.
"""
import json, re, subprocess, sys

bare = sys.argv[1]
TRAILER = re.compile(r"Entire-Checkpoint:\s*((?:[0-9a-f]{12}|[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}))(?:\s|$)")

def git(*args, check=True):
    r = subprocess.run(["git", "-C", bare, *args], capture_output=True)
    if check and r.returncode:
        sys.exit(f"git {' '.join(args)}: {r.stderr.decode()}")
    return r

def show(commit, path):
    r = git("show", f"{commit}:{path}", check=False)
    return r.stdout if r.returncode == 0 else None

ids = list(dict.fromkeys(TRAILER.findall(sys.stdin.read())))
print("trailers:", ids)
for cid in ids:
    ref = f"refs/entire/checkpoints/{cid[-2:]}/{cid}"
    prefix = ""
    tip = git("rev-parse", "--verify", "-q", ref, check=False).stdout.decode().strip()
    if not tip and re.fullmatch(r"[0-9a-f]{12}", cid):
        ref, prefix = "refs/heads/entire/checkpoints/v1", f"{cid[:2]}/{cid[2:]}/"
        tip = git("rev-parse", "--verify", "-q", ref, check=False).stdout.decode().strip()
    if not tip:
        print(f"{cid}: no ref"); continue
    print(f"\n== {cid}\nref: {ref}  tip: {tip}  root: /{prefix}")
    print("history:"); print(git("log", "--format=  %h %p| %s", tip).stdout.decode().rstrip())
    print("tree:")
    for line in git("ls-tree", "-r", "-l", tip, *([prefix] if prefix else [])).stdout.decode().splitlines():
        print("  " + line)
    root = json.loads(show(tip, prefix + "metadata.json"))
    print("root metadata.json:"); print(json.dumps(root, indent=2))
    for i, s in enumerate(root["sessions"]):
        meta = json.loads(show(tip, s["metadata"].lstrip("/")))
        print(f"session {i} metadata.json:"); print(json.dumps(meta, indent=2))
        full = show(tip, s["transcript"].lstrip("/"))
        n = 1
        while (chunk := show(tip, f"{s['transcript'].lstrip('/')}.{n:03d}")) is not None:
            full += b"\n" + chunk; n += 1
        lines = full.decode().splitlines()
        start = meta.get("checkpoint_transcript_start", 0)
        print(f"full.jsonl: {len(lines)} lines, {n} chunk(s); this checkpoint = lines[{start}:] ({len(lines) - start} lines)")
        def brief(l):
            d = json.loads(l); m = d.get("message") or {}; c = m.get("content")
            if isinstance(c, list):
                c = " | ".join(b.get("text") or (b.get("name") and f"tool_use:{b['name']}") or b.get("type", "?") for b in c)
            return f"{d.get('type')}: {str(c or '')[:90]!r}"
        types = {}
        for l in lines: t = json.loads(l).get("type"); types[t] = types.get(t, 0) + 1
        print("  line types:", types)
        if start: print("  last line before slice:", brief(lines[start - 1]))
        for l in lines[start:]:
            if json.loads(l).get("type") in ("user", "assistant"): print("   ", brief(l))
        if s.get("compact_transcript"):
            compact = show(tip, s["compact_transcript"].lstrip("/")).decode().splitlines()
            cstart = meta.get("compact_transcript_start")
            print(f"transcript.jsonl: {len(compact)} lines; compact_transcript_start={cstart}; slice:")
            for l in compact[cstart or 0:]:
                d = json.loads(l)
                print("   ", {k: d[k] for k in ("v", "agent", "cli_version", "type")}, json.dumps(d["content"])[:140])
        print("prompt.txt:", repr(show(tip, s["prompt"].lstrip("/")).decode()))
        if s.get("content_hash"):
            import hashlib
            stored = show(tip, s["content_hash"].lstrip("/")).decode()
            print("content_hash.txt:", stored, "| matches sha256(full.jsonl):", stored == "sha256:" + hashlib.sha256(full).hexdigest())
