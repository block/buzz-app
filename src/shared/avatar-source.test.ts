import { expect, it } from "vitest";
import {
  animatedAvatar,
  animatedAvatarPicture,
  avatarMedia,
  avatarSource,
  legacyEmojiPicture,
} from "./avatar-source";

// Exact output of Buzz mobile's emojiAvatarDataUrl("🛹", 0xFFFFB84D).
const mobile =
  "data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%22512%22%20height%3D%22512%22%20viewBox%3D%220%200%20512%20512%22%3E%3Crect%20width%3D%22512%22%20height%3D%22512%22%20rx%3D%22256%22%20fill%3D%22%23FFB84D%22%2F%3E%3Ctext%20x%3D%2250%25%22%20y%3D%2256%25%22%20dominant-baseline%3D%22middle%22%20text-anchor%3D%22middle%22%20font-size%3D%22258%22%3E%F0%9F%9B%B9%3C%2Ftext%3E%3C%2Fsvg%3E";
const svg = (text: string) =>
  decodeURIComponent(mobile.slice("data:image/svg+xml,".length)).replace(
    "🛹",
    text,
  );

it("displays Buzz mobile's emoji avatar inline", () => {
  expect(avatarSource(mobile)).toBe(mobile);
  expect(avatarMedia(mobile, () => "https://media.example/never")).toBe(mobile);
});

it("renders only the re-encoded template, never the stored bytes", () => {
  // A raw "#" would end the data URL at the fill color.
  const rawHash = mobile.replace("%23", "#");
  expect(avatarSource(rawHash)).toBe(mobile);
});

it.each([
  "data:image/svg+xml,%3Csvg%3E%3Cscript%3Ealert(1)%3C%2Fscript%3E%3C%2Fsvg%3E",
  `data:image/svg+xml,${encodeURIComponent(svg('<image href="https://example.test/track"/>'))}`,
  `data:image/svg+xml,${encodeURIComponent(svg("🛹").replace("<text ", '<text onclick="alert(1)" '))}`,
])("still rejects other SVG: %s", (picture) => {
  expect(avatarSource(picture)).toBeUndefined();
});

it.each(["\ud83d", "\udef9", "🛹\ud83d"])(
  "rejects ill-formed emoji text without throwing: %j",
  (text) => {
    // Left raw in the URL: a lone surrogate has no percent-encoding.
    const picture = mobile.replace("%F0%9F%9B%B9", text);
    expect(legacyEmojiPicture(picture)).toBeUndefined();
    expect(avatarSource(picture)).toBeUndefined();
  },
);

const poster = `https://relay.test/media/${"a".repeat(64)}.png`;
const animation = `https://relay.test/media/${"b".repeat(64)}.png`;
const descriptor = `${poster}#buzz-anim=https%3A%2F%2Frelay.test%2Fmedia%2F${"b".repeat(64)}.png`;

it("writes and reads old Buzz's animated avatar descriptor", () => {
  expect(animatedAvatarPicture(poster, animation)).toBe(descriptor);
  expect(animatedAvatar(descriptor)).toEqual({ poster, animation });
  expect(avatarSource(descriptor)).toBe(descriptor);
});

it("reads old desktop's fully escaped animation", () => {
  const escaped = animation.replace(
    /[^A-Za-z0-9]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  expect(animatedAvatar(`${poster}#buzz-anim=${escaped}`)).toEqual({
    poster,
    animation,
  });
});

it.each([
  ["no mark", poster],
  ["mark first", descriptor.slice(poster.length)],
  ["empty payload", `${poster}#buzz-anim=`],
  ["bad escape", `${descriptor}%zz`],
  ["cut escape", `${descriptor}%4`],
  ["raw #", `${descriptor}#x`],
  ["http part", descriptor.replace("https://", "http://")],
  ["other relay", descriptor.replace("relay.test%2F", "other.test%2F")],
  ["query", `${descriptor}%3Fq`],
  ["not media", descriptor.replace("%2Fmedia%2F", "%2Fother%2F")],
  ["over 2,048 characters", descriptor.replaceAll("relay", "r".repeat(1000))],
])("rejects an animated avatar with %s", (_, picture) => {
  expect(animatedAvatar(picture)).toBeUndefined();
});

it("refuses to describe a non-relay animation", () => {
  expect(() =>
    animatedAvatarPicture(poster, "https://example.test/a.png"),
  ).toThrow("The server did not return an animated avatar.");
});
