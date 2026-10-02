// One self-contained ES module beside its manifest: the shape the plugin loader takes.
import { build } from "esbuild";
import { copyFile, mkdir } from "node:fs/promises";

await mkdir(new URL("dist/", import.meta.url), { recursive: true });
await build({
  entryPoints: ["src/plugin.ts"],
  outfile: "dist/plugin.js",
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  minify: true,
  legalComments: "none",
  logLevel: "info",
});
await copyFile(
  new URL("manifest.json", import.meta.url),
  new URL("dist/manifest.json", import.meta.url),
);
