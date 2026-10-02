import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// Tests that need the Workers runtime: Durable Objects, Workflows and D1, in
// workerd, with the local Wrangler config. They load `src/server/test-entry.ts`
// rather than the app's entry, which only builds under TanStack Start's own
// Vite plugin. Name these files `*.worker.test.ts`.
export default defineConfig({
  resolve: { tsconfigPaths: true },
  plugins: [
    cloudflareTest({
      main: "./src/server/test-entry.ts",
      wrangler: { configPath: "./wrangler.jsonc" },
    }),
  ],
  test: {
    name: "worker",
    include: ["src/**/*.worker.test.ts"],
  },
});
