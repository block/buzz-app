import { build } from "vite";
import { expect, it } from "vitest";
import { avatarCodecs } from "./avatar-codecs";

it.each([
  ["macos", 0, 49],
  ["windows", 49, 0],
  ["linux", 49, 0],
  [undefined, 49, 49],
] as const)(
  "emits only supported native avatar codecs for %s",
  async (platform, webm, mp4) => {
    const result = await build({
      configFile: false,
      logLevel: "silent",
      plugins: [avatarCodecs(platform)],
      build: {
        write: false,
        minify: false,
        assetsInlineLimit: 0,
        rollupOptions: {
          input: "src/features/agents/avatar-packs.ts",
          preserveEntrySignatures: "strict",
        },
      },
    });
    if (Array.isArray(result) || !("output" in result))
      throw new Error("Unexpected build result");
    const assets = result.output.filter((item) => item.type === "asset");
    expect(
      assets.filter((item) => item.fileName.endsWith(".webm")),
    ).toHaveLength(webm);
    expect(
      assets.filter((item) => item.fileName.endsWith(".mp4")),
    ).toHaveLength(mp4);
    expect(
      assets.filter((item) => item.fileName.endsWith(".png")),
    ).toHaveLength(49);
  },
);
