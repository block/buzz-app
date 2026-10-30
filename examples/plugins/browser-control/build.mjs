import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
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

// Match the repository formatter so rebuilding unchanged source preserves the artifact.
execFileSync(
  process.execPath,
  [
    createRequire(import.meta.url).resolve("@biomejs/biome/bin/biome"),
    "format",
    "--write",
    fileURLToPath(new URL("plugin.js", import.meta.url)),
  ],
  { stdio: "inherit" },
);
