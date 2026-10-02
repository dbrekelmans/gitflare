import { demo } from "@gitflare/testing/demo";
import { describe, expect, it } from "vitest";
import { stillImporting } from "./import-status";

describe("stillImporting, which drives the repositories list and detail page's auto-refresh", () => {
  const [first] = demo.repositories;
  if (!first) throw new Error("the demo has no repositories");

  it("is true for a repository with no readyAt and no importFailedAt", () => {
    expect(stillImporting({ ...first, readyAt: null, importFailedAt: null })).toBe(true);
  });

  it("is false once the repository is ready", () => {
    expect(stillImporting({ ...first, readyAt: Date.now(), importFailedAt: null })).toBe(false);
  });

  it("is false once the import is known to have failed, so a dead import stops being polled", () => {
    expect(stillImporting({ ...first, readyAt: null, importFailedAt: Date.now() })).toBe(false);
  });
});
