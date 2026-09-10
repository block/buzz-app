import { defineConfig, loadEnv, type PluginOption } from "vite";
import react from "@vitejs/plugin-react";
import {
  parseCommunityAliases,
  relayOrigin,
} from "./src/features/communities/destination.ts";

export default defineConfig(async ({ mode }) => {
  const env = loadEnv(mode, ".", "BUZZ_");
  const live = env.BUZZ_LIVE === "1";
  const aliases = env.BUZZ_COMMUNITY_ALIASES ?? "";
  parseCommunityAliases(aliases);
  // Public routing configuration only; the viewer pin and credentials stay in Node.
  const defaultRelay = env.BUZZ_RELAY_URL?.trim();
  if (defaultRelay) relayOrigin(defaultRelay);
  const plugins: PluginOption[] = [react()];
  if (live)
    plugins.push(
      (await import("./dev/relay-broker.mjs")).relayBrokerPlugin({
        authorizedViewer: env.BUZZ_DEV_VIEWER,
        relayUrl: defaultRelay,
        communityAliases: aliases,
      }),
    );
  return {
    plugins,
    define: {
      "import.meta.env.VITE_BUZZ_LIVE": JSON.stringify(live ? "1" : "0"),
      "import.meta.env.VITE_BUZZ_COMMUNITY_ALIASES": JSON.stringify(aliases),
    },
    clearScreen: false,
    server: {
      port: 1430,
      strictPort: true,
      watch: { ignored: ["**/src-tauri/**", "**/target/**"] },
    },
  };
});
