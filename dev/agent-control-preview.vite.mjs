// Real app entry, with no dotenv loading or live development broker.
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  envDir: false,
  plugins: [react()],
  define: {
    "import.meta.env.VITE_BUZZ_LIVE": JSON.stringify("0"),
    "import.meta.env.VITE_BUZZ_COMMUNITY_ALIASES": JSON.stringify(""),
  },
  server: {
    host: "127.0.0.1",
    port: 1445,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**", "**/target/**"] },
  },
});
