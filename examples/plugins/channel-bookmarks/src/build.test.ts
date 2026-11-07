import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { build } from "vite";

it("ships the current self-contained artifact and manifest", async () => {
  vi.stubEnv("NODE_ENV", "production");
  try {
    const result = await build({
      configFile: fileURLToPath(new URL("../vite.config.mjs", import.meta.url)),
      build: { write: false },
      logLevel: "silent",
    });
    const outputs = Array.isArray(result) ? result : [result];
    for (const output of outputs) {
      if (!("output" in output))
        throw new Error("Expected a non-watching build");
      expect(output.output.map((file) => file.fileName).sort()).toEqual([
        "manifest.json",
        "plugin.js",
      ]);
      for (const file of output.output) {
        const shipped = await readFile(
          new URL(`../dist/${file.fileName}`, import.meta.url),
          "utf8",
        );
        const digest = (value: string | Uint8Array) =>
          createHash("sha256").update(value).digest("hex");
        expect(digest(shipped)).toBe(
          digest(file.type === "chunk" ? file.code : file.source),
        );
      }
    }
  } finally {
    vi.unstubAllEnvs();
  }
});
