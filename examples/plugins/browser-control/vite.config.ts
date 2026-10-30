import { defineConfig } from "vite";

export default defineConfig({
  publicDir: false,
  oxc: { jsx: { runtime: "classic" } },
  build: {
    outDir: "dist",
    emptyOutDir: false,
    minify: false,
    lib: {
      entry: "src/index.ts",
      formats: ["es"],
      fileName: () => "plugin.js",
    },
    rolldownOptions: { output: { codeSplitting: false } },
  },
  plugins: [
    {
      name: "self-contained-plugin",
      resolveId(id) {
        if (
          /^react(?:-dom)?(?:\/|$)/.test(id) ||
          id.startsWith("@deepseek-ai/cordis")
        )
          throw new Error("Use injected React and type-only host imports");
      },
      generateBundle(_options, bundle) {
        const outputs = Object.values(bundle);
        if (
          outputs.length !== 1 ||
          outputs[0]?.type !== "chunk" ||
          outputs[0].imports.length
        )
          throw new Error("The plugin must be one self-contained module");
      },
    },
  ],
});
