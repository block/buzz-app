import { describe, expect, test } from "vitest";
import {
  communityFromScope,
  gifMarkdown,
  normalizeKlipyGifs,
  relayKlipySearchPath,
} from "./gifs";

const asset = (url: string, width = 320, height = 180) => ({
  url,
  width,
  height,
  size: 1234,
});

describe("relay KLIPY capability", () => {
  test("accepts only the advertised relay-relative provider path", () => {
    expect(
      relayKlipySearchPath({
        supported_extensions: ["buzz-gif"],
        gif: { provider: "klipy", search: "/gifs/search" },
      }),
    ).toBe("/gifs/search");
    for (const search of [
      "https://provider.invalid/search",
      "//provider.invalid/search",
      "/gifs/../secret",
      "/gifs/search?key=secret",
      "/gifs/%2e%2e/secret",
    ])
      expect(
        relayKlipySearchPath({
          supported_extensions: ["buzz-gif"],
          gif: { provider: "klipy", search },
        }),
      ).toBeNull();
  });

  test("requires both the extension and KLIPY provider", () => {
    expect(
      relayKlipySearchPath({
        supported_extensions: [],
        gif: { provider: "klipy", search: "/gifs/search" },
      }),
    ).toBeNull();
    expect(
      relayKlipySearchPath({
        supported_extensions: ["buzz-gif"],
        gif: { provider: "other", search: "/gifs/search" },
      }),
    ).toBeNull();
  });
});

test("communityFromScope separates an HTTPS community from its viewer", () => {
  const viewer = "a".repeat(64);
  expect(communityFromScope(`https://buzz.example:${viewer}`)).toBe(
    "https://buzz.example",
  );
  expect(communityFromScope(`http://buzz.example:${viewer}`)).toBeNull();
  expect(communityFromScope("not-a-session-scope")).toBeNull();
});

test("normalizes usable GIF records and rejects unsafe or incomplete media", () => {
  expect(
    normalizeKlipyGifs([
      {
        id: 7,
        type: "gif",
        slug: "hello",
        title: " Hello ",
        file: {
          md: { gif: asset("https://cdn.example/original.gif") },
          sm: { webp: asset("https://cdn.example/preview.webp", 160, 90) },
        },
      },
      {
        type: "gif",
        slug: "unsafe",
        file: { md: { gif: asset("http://cdn.example/unsafe.gif") } },
      },
      { type: "ad", slug: "advertisement", file: {} },
    ]),
  ).toEqual([
    {
      id: 7,
      slug: "hello",
      title: "Hello",
      original: asset("https://cdn.example/original.gif"),
      preview: asset("https://cdn.example/preview.webp", 160, 90),
    },
  ]);
});

test("gifMarkdown produces attachment syntax without malformed alt text", () => {
  expect(
    gifMarkdown({
      id: 1,
      slug: "wave",
      title: "Wave [hello]",
      original: asset("https://cdn.example/wave(test).gif"),
      preview: asset("https://cdn.example/wave.webp"),
    }),
  ).toBe("![Wave hello](https://cdn.example/wave%28test%29.gif)");
});
