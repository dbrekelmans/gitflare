import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// `pnpm dev` and tests use wrangler.jsonc, which declares only what runs
// locally without an account. A release is built against wrangler.deploy.jsonc.
const configPath = process.env.GITFLARE_WRANGLER_CONFIG ?? "./wrangler.jsonc";

export default defineConfig({
  resolve: { tsconfigPaths: true },
  server: { port: 3000 },
  plugins: [
    cloudflare({ configPath, viteEnvironment: { name: "ssr" } }),
    tailwindcss(),
    tanstackStart({
      importProtection: {
        // Everything under src/server reads bindings; none of it may reach the browser.
        client: { files: ["**/*.server.*", "**/src/server/**"] },
      },
    }),
    react(),
  ],
});
