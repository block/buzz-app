import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Offline preview only: no dotenv, broker, app startup, native host, or live data.
const root = fileURLToPath(new URL("../..", import.meta.url));
export default defineConfig({
  root,
  envDir: false,
  publicDir: false,
  plugins: [react()],
  server: { host: "127.0.0.1", port: 1451, strictPort: true },
  build: {
    outDir: "dist/agent-activity-preview",
    rollupOptions: {
      input: ["index", "playground"].map(
        (page) => `${root}/examples/agent-activity/${page}.html`,
      ),
    },
  },
});
