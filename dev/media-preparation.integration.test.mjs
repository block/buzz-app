import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { expect, test } from "vitest";
import { prepareMedia } from "./media-preparation.mjs";

test("tiled HEIC preparation preserves the full image dimensions", async () => {
  const bytes = await readFile(
    new URL("../tests/fixtures/media/tiled.heic", import.meta.url),
  );
  const req = Readable.from([bytes]);
  req.headers = { "x-attachment-name": "tiled.heic" };
  await prepareMedia(
    req,
    new AbortController().signal,
    async (path, type, size) => {
      expect(type).toBe("image/jpeg");
      expect(size).toBeGreaterThan(0);
      const dimensions = execFileSync(
        "ffprobe",
        [
          "-v",
          "error",
          "-show_entries",
          "stream=width,height",
          "-of",
          "csv=p=0",
          path,
        ],
        { encoding: "utf8" },
      );
      expect(dimensions.trim()).toBe("1536,1024");
    },
  );
}, 30_000);
