import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Serves and builds the gallery. The package itself ships as source.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: { outDir: "dist/gallery" },
});
