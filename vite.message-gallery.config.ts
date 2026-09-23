import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Product specimens have their own document, CSS reset and bundle. The design
// viewer's core-only import guard remains unchanged.
export default defineConfig({
  plugins: [react()],
  publicDir: false,
  base: "./",
  build: {
    outDir: "dist/design-system",
    emptyOutDir: false,
    rollupOptions: { input: "tests/fixtures/message-gallery.html" },
  },
});
