import { describe, expect, it } from "vitest";
import { concatBytes, type Fetch, pktLine, receivePack } from "./wire";

const remote = { url: "https://artifacts.test/git/ns/app.git", secret: "s" };
const update = { ref: "refs/heads/main", old: "a".repeat(40), new: "b".repeat(40) };
const flush = new TextEncoder().encode("0000");

/** A receive-pack endpoint that answers with these report-status lines. */
function reporting(...lines: string[]): Fetch {
  const body = concatBytes([...lines.map((line) => pktLine(`${line}\n`)), flush]);
  return async () => new Response(body, { status: 200 });
}

describe("receivePack", () => {
  it("returns when the ref was updated", async () => {
    await receivePack(reporting("unpack ok", `ok ${update.ref}`), remote, update, new Uint8Array());
  });

  it("calls a ref that moved meanwhile a conflict", async () => {
    for (const reason of [
      "stale ref",
      "incorrect old value provided",
      "non-fast-forward",
      "fetch first",
      "failed to lock",
    ]) {
      await expect(
        receivePack(
          reporting("unpack ok", `ng ${update.ref} ${reason}`),
          remote,
          update,
          new Uint8Array(),
        ),
      ).rejects.toMatchObject({ code: "conflict", message: expect.stringContaining(reason) });
    }
  });

  it("does not call any other refusal a conflict", async () => {
    for (const lines of [
      ["unpack ok", `ng ${update.ref} pre-receive hook declined`],
      ["unpack ok", `ng ${update.ref} missing necessary objects`],
      ["unpack ok"],
    ]) {
      await expect(
        receivePack(reporting(...lines), remote, update, new Uint8Array()),
      ).rejects.toMatchObject({ code: "unavailable" });
    }
  });
});
