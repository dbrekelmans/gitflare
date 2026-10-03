import { defineConfig } from "vitest/config";

// One config for the whole repository. `pnpm test` runs every project; a
// package's own `test` script runs this config filtered to its directory.
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          environment: "node",
          include: [
            "packages/*/src/**/*.test.ts",
            "apps/cli/src/**/*.test.ts",
            "apps/installer/src/**/*.test.ts",
            "apps/forge/src/**/*.test.ts",
          ],
          exclude: ["apps/forge/src/**/*.worker.test.ts", "packages/ui/**"],
        },
      },
      "apps/forge/vitest.web.config.ts",
      "apps/forge/vitest.worker.config.ts",
      "packages/ui/vitest.config.ts",
    ],
  },
});
