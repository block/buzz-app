import { defineConfig } from "vite";
import manifest from "./src/agent-plugins/claude-code/manifest.json" with {
  type: "json",
};

// Builds the Claude Code agent type as an installable plugin: one
// self-contained `plugin.js` beside its `manifest.json`, using the host's React
// and services through `ctx`. Choose the folder with `--outDir`, e.g.
// `pnpm plugin:claude-code --outDir ~/buzz-plugins/claude-code`.
export default defineConfig({
  publicDir: false,
  build: {
    outDir: "dist-plugins/claude-code",
    emptyOutDir: true,
    minify: false,
    lib: {
      entry: "src/agent-plugins/claude-code/index.ts",
      formats: ["es"],
      fileName: () => "plugin.js",
    },
    rolldownOptions: { output: { codeSplitting: false } },
  },
  plugins: [
    {
      name: "installed-plugin-contract",
      enforce: "pre",
      resolveId(id) {
        if (
          /^react(?:-dom)?(?:\/|$)/.test(id) ||
          id === "@deepseek-ai/cordis" ||
          id.startsWith("@deepseek-ai/cordis/") ||
          id.startsWith("@tauri-apps/")
        )
          throw new Error(
            `${id}: host capabilities are supplied by Buzz; use type-only imports`,
          );
      },
      generateBundle(_options, bundle) {
        const outputs = Object.values(bundle);
        const plugin = outputs[0];
        if (
          outputs.length !== 1 ||
          plugin?.type !== "chunk" ||
          plugin.imports.length
        )
          throw new Error("A plugin is one self-contained JS module");
        if (!plugin.exports.includes("apply"))
          throw new Error("Export apply(ctx)");
        this.emitFile({
          type: "asset",
          fileName: "manifest.json",
          source: `${JSON.stringify(manifest, null, 2)}\n`,
        });
      },
    },
  ],
});
