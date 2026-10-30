import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const result = await build({
  root: fileURLToPath(new URL(".", import.meta.url)),
  configFile: fileURLToPath(new URL("vite.config.ts", import.meta.url)),
  build: { write: false },
});
const bundle = Array.isArray(result) ? result[0] : result;
const module = bundle.output.find((item) => item.type === "chunk");
await writeFile(new URL("plugin.js", import.meta.url), module.code);
