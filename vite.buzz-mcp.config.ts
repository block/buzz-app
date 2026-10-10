import { defineConfig } from "vite";

// Builds the standalone Buzz MCP server: one Node script with its dependencies
// bundled, run as `node dist-buzz-mcp/buzz-mcp.mjs`.
export default defineConfig({
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
});
