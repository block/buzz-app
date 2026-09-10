import { copyFile } from "node:fs/promises";
await copyFile(
  new URL("manifest.json", import.meta.url),
  new URL("dist/manifest.json", import.meta.url),
);
