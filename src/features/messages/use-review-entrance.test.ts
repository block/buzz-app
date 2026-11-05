// @vitest-environment jsdom
import { expect, it } from "vitest";
import { readReviewOrigin } from "./use-review-entrance";

it("reads the original image, not the blurred thumbnail, for the origin aspect", () => {
  const preview = document.createElement("a");
  preview.dataset.mediaPreview = "";
  preview.dataset.reviewMotion = "pointer";
  preview.getBoundingClientRect = () => new DOMRect(0, 0, 300, 100);
  const thumbnail = document.createElement("img");
  thumbnail.dataset.thumbnail = "";
  const original = document.createElement("img");
  for (const [image, width, height] of [
    [thumbnail, 320, 213],
    [original, 2400, 800],
  ] as const)
    Object.defineProperties(image, {
      naturalWidth: { value: width },
      naturalHeight: { value: height },
    });
  preview.append(thumbnail, original);
  expect(readReviewOrigin(preview)?.aspect).toBe(3);
});
