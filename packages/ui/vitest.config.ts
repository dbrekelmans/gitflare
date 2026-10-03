import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// Component tests for the shared UI package: React in happy-dom.
export default defineConfig({
  plugins: [react()],
  test: {
    name: "ui",
    environment: "happy-dom",
    include: ["src/**/*.test.tsx"],
    passWithNoTests: true,
  },
});
