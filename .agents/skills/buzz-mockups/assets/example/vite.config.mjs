import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwind from "@tailwindcss/postcss";

const repoRoot = fileURLToPath(new URL("../../../../../", import.meta.url));

// Keep the example independent of the app's live-service config.
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  base: "./",
  publicDir: false,
  plugins: [react()],
  resolve: {
    alias: {
      "@buzz": fileURLToPath(new URL("../../../../../src/", import.meta.url)),
    },
    dedupe: ["react", "react-dom"],
  },
  css: { postcss: { plugins: [tailwind({ base: repoRoot })] } },
  build: { outDir: "dist", emptyOutDir: true },
});
