import { defineConfig } from "vite";
import manifest from "./src/agent-plugins/codex/manifest.json" with {
  type: "json",
};

export default defineConfig({
  publicDir: false,
  build: {
    outDir: "dist-plugins/codex",
    emptyOutDir: true,
    minify: false,
    lib: {
      entry: "src/agent-plugins/codex/index.ts",
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
          plugin.imports.length ||
          !plugin.exports.includes("apply")
        )
          throw new Error(
            "A plugin must be one self-contained module exporting apply(ctx)",
          );
        this.emitFile({
          type: "asset",
          fileName: "manifest.json",
          source: `${JSON.stringify(manifest, null, 2)}\n`,
        });
      },
    },
  ],
});
