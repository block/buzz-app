import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwind from "@tailwindcss/postcss";

// Run from the Buzz repository root; do not import the app's live-service config.
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  base: "./",
  publicDir: false,
  plugins: [react()],
  resolve: {
    alias: { "@buzz": resolve("src") },
    dedupe: ["react", "react-dom"],
  },
  css: { postcss: { plugins: [tailwind()] } },
  build: { outDir: "dist", emptyOutDir: true },
});
