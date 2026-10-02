import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// Component tests for routes and components: React in happy-dom, no Worker.
export default defineConfig({
  plugins: [react()],
  resolve: { tsconfigPaths: true },
  test: {
    name: "web",
    environment: "happy-dom",
    include: ["src/**/*.test.tsx"],
    passWithNoTests: true,
  },
});
