import { expect, it } from "vitest";
import { avatarMedia, avatarSource } from "./avatar-source";

const emojiSvg =
  '<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512"><rect width="512" height="512" rx="256" fill="#2ED3A2"/><text x="50%" y="56%" dominant-baseline="middle" text-anchor="middle" font-size="258">🚀</text></svg>';
const emojiPicture = `data:image/svg+xml,${encodeURIComponent(emojiSvg)}`;

it("accepts only Buzz's bounded, fixed-template inline emoji avatar SVG", () => {
  expect(avatarSource(emojiPicture)).toBe(emojiPicture);
  expect(avatarMedia(emojiPicture, undefined)).toBe(emojiPicture);

  for (const svg of [
    emojiSvg.replace('rx="256"', 'rx="300"'),
    emojiSvg.replace('fill="#2ED3A2"', 'fill="url(https://evil.example/a)"'),
    emojiSvg.replace("<text ", '<text onload="alert(1)" '),
    emojiSvg.replace("🚀", "<script>alert(1)</script>"),
    emojiSvg.replace("</svg>", '<image href="https://evil.example/a"/></svg>'),
    emojiSvg.replace("</svg>", "<foreignObject/></svg>"),
  ]) {
    expect(
      avatarSource(`data:image/svg+xml,${encodeURIComponent(svg)}`),
    ).toBeUndefined();
  }
  expect(avatarSource("data:image/svg+xml,%ZZ")).toBeUndefined();
  expect(avatarSource("data:image/svg+xml;base64,PHN2Zz4=")).toBeUndefined();
  expect(
    avatarSource(`data:image/svg+xml,${"%41".repeat(32_768)}`),
  ).toBeUndefined();
});

it("keeps existing HTTPS and raster avatar sources", () => {
  expect(avatarSource("https://images.example/avatar.png")).toBe(
    "https://images.example/avatar.png",
  );
  expect(avatarSource("data:image/png;base64,AAAA")).toBe(
    "data:image/png;base64,AAAA",
  );
  expect(avatarMedia("https://images.example/avatar.png", (url) => url)).toBe(
    "https://images.example/avatar.png",
  );
});
