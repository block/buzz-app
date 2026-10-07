import { defineConfig } from "vitest/config";
import { readFile } from "node:fs/promises";
export default defineConfig({
  plugins: [
    {
      name: "prompt-text",
      async load(id) {
        if (id.endsWith(".md"))
          return `export default ${JSON.stringify(await readFile(id, "utf8"))}`;
      },
    },
  ],
  test: {
    include: ["examples/plugins/codex-agent-plugin/test/**/*.test.{ts,tsx}"],
  },
});
