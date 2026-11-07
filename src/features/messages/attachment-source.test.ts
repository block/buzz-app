import { expect, it } from "vitest";
import { attachmentPreview, isNativeMediaSource } from "./attachment-source";

const media = `https://relay.test/media/${"a".repeat(64)}.thumb.jpg`;
it.each(["buzz-media://localhost", "http://buzz-media.localhost"])(
  "recognizes exact %s media sources",
  (origin) => {
    expect(isNativeMediaSource(`${origin}/${encodeURIComponent(media)}`)).toBe(
      true,
    );
  },
);
it.each([
  `buzz-media://evil.test/${encodeURIComponent(media)}`,
  `https://buzz-media.localhost/${encodeURIComponent(media)}`,
  `http://buzz-media.localhost.evil.test/${encodeURIComponent(media)}`,
  `buzz-media://localhost:123/${encodeURIComponent(media)}`,
  `buzz-media://localhost/${encodeURIComponent(media)}?url=evil`,
  `buzz-media://localhost/${encodeURIComponent(media)}#fragment`,
  `buzz-media://localhost/${encodeURIComponent("https://relay.test/other")}`,
  `buzz-media://localhost/${encodeURIComponent("https://evil.test/media/../../../secret")}`,
  `buzz-media://localhost/${encodeURIComponent(`http://relay.test/media/${"a".repeat(64)}`)}`,
  `buzz-media://localhost/${encodeURIComponent(`https://user:pass@relay.test/media/${"a".repeat(64)}`)}`,
  "buzz-media://localhost/%invalid",
  "javascript:alert(1)",
])("rejects untrusted native lookalike %s", (source) => {
  expect(isNativeMediaSource(source)).toBe(false);
});

it("previews a gallery image with its signed or relay thumbnail, never the original again", () => {
  const relay = `https://relay.test/media/${"b".repeat(64)}.png`;
  const proxy = (url: string, size?: "small") =>
    url.startsWith("https://relay.test/")
      ? `/api/relay/media?url=${encodeURIComponent(size ? url.replace(/\.png$/, ".thumb.jpg") : url)}`
      : url;
  const image = { url: relay, kind: "image" } as const;
  expect(attachmentPreview(image, proxy)).toBe(
    `/api/relay/media?url=${encodeURIComponent(relay.replace(/\.png$/, ".thumb.jpg"))}`,
  );
  expect(attachmentPreview({ ...image, previewUrl: media }, proxy)).toBe(
    `/api/relay/media?url=${encodeURIComponent(media)}`,
  );
  expect(
    attachmentPreview({ ...image, previewUrl: relay }, proxy),
  ).toBeUndefined();
  const native = `buzz-media://localhost/${encodeURIComponent(media)}`;
  expect(
    attachmentPreview({ ...image, previewUrl: media }, (url) =>
      url.startsWith("https://relay.test/")
        ? `buzz-media://localhost/${encodeURIComponent(url)}`
        : url,
    ),
  ).toBe(native);
});

it("never fetches a third-party URL as a gallery preview", () => {
  const proxy = (url: string) =>
    url.startsWith("https://relay.test/")
      ? `/api/relay/media?url=${encodeURIComponent(url)}`
      : url;
  const thirdParty = { url: "https://cdn.test/a.png", kind: "image" } as const;
  expect(attachmentPreview(thirdParty, proxy)).toBeUndefined();
  expect(
    attachmentPreview(
      { ...thirdParty, previewUrl: "https://cdn.test/a-small.png" },
      proxy,
    ),
  ).toBeUndefined();
  expect(
    attachmentPreview(
      {
        url: `https://relay.test/media/${"b".repeat(64)}.png`,
        kind: "image",
        previewUrl: "https://tracker.test/pixel.png",
      },
      proxy,
    ),
  ).toBeUndefined();
});
