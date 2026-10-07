import { build } from "rolldown";
import { copyFile, mkdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL(".", import.meta.url));
await mkdir(`${root}/dist`, { recursive: true });
await build({
  input: `${root}/src/plugin.ts`,
  plugins: [
    {
      name: "prompt-text",
      async load(id) {
        if (id.endsWith(".md") || id.endsWith(".svg?raw"))
          return `export default ${JSON.stringify(await readFile(id.replace(/\?raw$/, ""), "utf8"))}`;
      },
    },
  ],
  output: { file: `${root}/dist/plugin.js`, format: "esm" },
});
await copyFile(`${root}/manifest.json`, `${root}/dist/manifest.json`);
