import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// No app startup, native bridge, or live broker in the product catalogue.
export default defineConfig({
  plugins: [react()],
  // Its own dependency cache: sharing the app's makes a parallel run of another
  // spec re-optimize mid-test and serve a half-built module graph.
  cacheDir: "node_modules/.vite-product-ui",
  publicDir: false,
  base: "./",
  server: {
    port: 1444,
    strictPort: true,
    open: "/tests/fixtures/product-ui.html#/design/product-ui/composer",
  },
  build: {
    outDir: "dist/product-ui",
    emptyOutDir: true,
    rollupOptions: { input: "tests/fixtures/product-ui.html" },
  },
});
