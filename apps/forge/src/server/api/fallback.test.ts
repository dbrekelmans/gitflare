import { ForgeError } from "@gitflare/core";
import { apiOperations, type ForgeApi } from "@gitflare/core/api";
import { demoUsers } from "@gitflare/testing/demo";
import { createFixtureApi } from "@gitflare/testing/fixture-api";
import { describe, expect, it } from "vitest";
import { withFixtureFallback } from "./fallback";
import { stubSlice } from "./stub";

const ctx = { user: demoUsers.maya };

function stubApi(): ForgeApi {
  return {
    account: stubSlice("account"),
    repositories: stubSlice("repositories"),
    sessions: stubSlice("sessions"),
    changes: stubSlice("changes"),
    threads: stubSlice("threads"),
    decisions: stubSlice("decisions"),
    dev: stubSlice("dev"),
  };
}

describe("fixture fallback", () => {
  it("stubs every operation the contract lists", async () => {
    const api = stubApi();
    for (const operation of apiOperations.changes) {
      expect(typeof api.changes[operation]).toBe("function");
    }
    await expect(api.account.me(ctx)).rejects.toMatchObject({ name: "NotImplementedError" });
  });

  it("answers an unbuilt operation from the fixture", async () => {
    const api = withFixtureFallback(stubApi(), createFixtureApi());
    expect((await api.account.me(ctx)).organisation.slug).toBe("northwind");
    expect((await api.changes.list(ctx, { scope: "all" })).length).toBe(3);
  });

  it("uses a built operation, and does not hide its errors", async () => {
    const live = stubApi();
    live.repositories.list = async () => [];
    live.changes.get = async () => {
      throw new ForgeError("forbidden", "no");
    };
    const api = withFixtureFallback(live, createFixtureApi());
    expect(await api.repositories.list(ctx)).toEqual([]);
    await expect(api.changes.get(ctx, { changeId: "chg_demo12" })).rejects.toMatchObject({
      code: "forbidden",
    });
  });
});
