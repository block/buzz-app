import { defineConfig, loadEnv, type PluginOption } from "vite";
import react from "@vitejs/plugin-react";
import {
  parseCommunityAliases,
  relayOrigin,
} from "./src/features/communities/destination.ts";

export default defineConfig(async ({ command, mode }) => {
  const env = loadEnv(mode, ".", "BUZZ_");
  // The development broker is the dev server's default: it runs whenever the
  // developer has pinned their public key. Production builds (`pnpm build`,
  // `pnpm tauri build`) never load it, regardless of .env.local contents.
  const live = command === "serve" && Boolean(env.BUZZ_DEV_VIEWER?.trim());
  const aliases = env.BUZZ_COMMUNITY_ALIASES ?? "";
  parseCommunityAliases(aliases);
  // Public routing configuration only; the viewer pin and credentials stay in Node.
  const defaultRelay = env.BUZZ_RELAY_URL?.trim();
  const defaultOrigin = defaultRelay ? relayOrigin(defaultRelay) : "";
  // Opt-in seed: a viewer with no saved client record on this dev origin starts
  // in the default relay's community. Only "1" enables it; builds never see it.
  const openRelay = live && env.BUZZ_DEV_OPEN_RELAY === "1";
  if (openRelay && !defaultOrigin)
    throw new Error(
      "BUZZ_DEV_OPEN_RELAY=1 requires BUZZ_RELAY_URL to name the community to open.",
    );
  const plugins: PluginOption[] = [react()];
  if (live)
    plugins.push(
      (await import("./dev/relay-broker.mjs")).relayBrokerPlugin({
        authorizedViewer: env.BUZZ_DEV_VIEWER,
        relayUrl: defaultRelay,
        communityAliases: aliases,
      }),
    );
  const profileReadyToken = process.env.BUZZ_PROFILE_VITE_READY_TOKEN;
  if (profileReadyToken)
    plugins.push({
      name: "buzz-profile-ready",
      configureServer(server) {
        server.httpServer?.once("listening", () => {
          console.log(`BUZZ_PROFILE_VITE_READY:${profileReadyToken}`);
        });
      },
    });
  return {
    plugins,
    define: {
      "import.meta.env.VITE_BUZZ_LIVE": JSON.stringify(live ? "1" : "0"),
      "import.meta.env.VITE_BUZZ_NOTIFICATIONS_PAUSED": JSON.stringify(
        command === "serve" && env.BUZZ_DEV_NOTIFICATIONS === "0" ? "1" : "0",
      ),
      "import.meta.env.VITE_BUZZ_COMMUNITY_ALIASES": JSON.stringify(aliases),
      "import.meta.env.VITE_BUZZ_OPEN_RELAY": JSON.stringify(
        openRelay ? defaultOrigin : "",
      ),
    },
    clearScreen: false,
    server: {
      port: 1430,
      strictPort: false,
      watch: { ignored: ["**/src-tauri/**", "**/target/**"] },
    },
  };
});
