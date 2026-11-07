import { expect, it } from "vitest";
import {
  activityPreviewText,
  messagePreviewText,
} from "./message-preview-text";

it("ends the excerpt before blank lines, with an ellipsis beside the text", () => {
  expect(
    messagePreviewText("Watch at 2x if you must lol\n\n\nVideo details"),
  ).toBe("Watch at 2x if you must lol…");
  expect(messagePreviewText("First paragraph\r\n \t\r\nMore text")).toBe(
    "First paragraph…",
  );
});

it("preserves single line breaks and leaves visual wrapping to the four-line clamp", () => {
  const text = "First line\nSecond line";
  expect(messagePreviewText(text)).toBe(text);
  const longParagraph = "A long message. ".repeat(100).trim();
  expect(messagePreviewText(longParagraph)).toBe(longParagraph);
});

it("ignores surrounding blank lines without implying missing content", () => {
  expect(messagePreviewText("\n\nShort message\n \n")).toBe("Short message");
  expect(messagePreviewText("\r\n \t\n")).toBe("");
});

it("shows activity excerpts as the prose their Markdown renders, capped at 280 characters", () => {
  expect(
    activityPreviewText(
      "[The fix](https://github.com/block/buzz-app/pull/2883) at `fd5498b7c` is **done**, ||secret||.\n\nMore",
    ),
  ).toBe("The fix at fd5498b7c is done, [Spoiler].…");
  expect(activityPreviewText("🙂".repeat(281))).toBe(`${"🙂".repeat(279)}…`);
});

it("keeps the source when its Markdown renders no prose, so the line is never blank", () => {
  expect(activityPreviewText("[1]: https://example.com")).toBe(
    "[1]: https://example.com",
  );
  expect(activityPreviewText("<!-- buzz:marker -->\n\nReal text here")).toBe(
    "<!-- buzz:marker -->…",
  );
});
