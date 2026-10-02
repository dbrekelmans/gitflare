import { ForgeError } from "@gitflare/core";
import type { ForgeApi } from "@gitflare/core/api";
import type { Services } from "../services";

/**
 * Local development helpers. Refuses everything unless the forge runs in dev mode.
 * Build task: `pipeline`.
 */
export function devApi(services: Services): ForgeApi["dev"] {
  return {
    async simulatePush(_ctx, push) {
      if (services.mode !== "dev") {
        throw new ForgeError("forbidden", "Pushes can only be simulated in local development.");
      }
      await services.pipeline.handlePush(push);
    },
  };
}
