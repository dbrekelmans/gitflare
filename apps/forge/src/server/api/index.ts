import type { ForgeApi } from "@gitflare/core/api";
import { createFixtureApi } from "@gitflare/testing/fixture-api";
import { getServices } from "../services";
import { accountApi } from "./account";
import { changesApi } from "./changes";
import { decisionsApi } from "./decisions";
import { devApi } from "./dev";
import { withFixtureFallback } from "./fallback";
import { repositoriesApi } from "./repositories";
import { sessionsApi } from "./sessions";
import { threadsApi } from "./threads";

let api: ForgeApi | undefined;

/** The forge's API, as server functions and server routes call it. Built once per isolate. */
export function forgeApi(): ForgeApi {
  if (api) return api;
  const services = getServices();
  const live: ForgeApi = {
    account: accountApi(services),
    repositories: repositoriesApi(services),
    sessions: sessionsApi(services),
    changes: changesApi(services),
    threads: threadsApi(services),
    decisions: decisionsApi(services),
    dev: devApi(services),
  };
  api = services.mode === "dev" ? withFixtureFallback(live, createFixtureApi()) : live;
  return api;
}
