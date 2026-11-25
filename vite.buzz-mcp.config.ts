import { defineConfig, loadEnv } from "vite";
import { relayOrigin } from "./src/features/communities/destination.ts";

// Builds the standalone Buzz MCP server: one Node script with its dependencies
// bundled, run as `node dist-buzz-mcp/buzz-mcp.mjs`.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "BUZZ_");
  // The same build settings as the app, so the standalone server applies the
  // channel naming rules in the communities the build lists.
  const namingCommunities = (env.BUZZ_CHANNEL_NAMING_ENFORCED_COMMUNITIES ?? "")
    .split(/\s+/)
    .filter(Boolean)
    .map(relayOrigin)
    .join(" ");
  return {
    define: {
      "import.meta.env.VITE_BUZZ_CHANNEL_NAMING_ENFORCED_COMMUNITIES":
        JSON.stringify(namingCommunities),
      "import.meta.env.VITE_BUZZ_CHANNEL_NAMING_GUIDELINES_URL": JSON.stringify(
        env.BUZZ_CHANNEL_NAMING_GUIDELINES_URL ?? "",
      ),
    },
    publicDir: false,
    ssr: { noExternal: true, target: "node" },
    build: {
      outDir: "dist-buzz-mcp",
      emptyOutDir: true,
      ssr: "src/buzz-mcp/main.ts",
      rolldownOptions: {
        output: { entryFileNames: "buzz-mcp.mjs", codeSplitting: false },
      },
    },
  };
});
