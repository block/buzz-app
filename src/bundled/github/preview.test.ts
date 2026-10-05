// @vitest-environment jsdom
import { expect, it } from "vitest";
import { bodyPreview, isTextBody } from "./preview";
import { MAX_MARKDOWN_LENGTH } from "../../features/relay/message-content";
const base = "https://github.com/sample/project/pull/1";
const image =
  "https://raw.githubusercontent.com/sample/project/main/example.png";

it("extracts the first readable line through formatting, references and inert HTML", () => {
  expect(
    bodyPreview(
      "\n**Keep** the [context](https://example.test) readable.\n\nLater line",
      undefined,
      base,
    ).text,
  ).toBe("Keep the context readable.");
  expect(
    bodyPreview(
      "<div><p>First line</p><p>Second line</p><script>ignored()</script></div>",
      undefined,
      base,
    ).text,
  ).toBe("First line");
  expect(
    bodyPreview(
      "<a href='https://example.test'>Linked</a> text",
      undefined,
      base,
    ).text,
  ).toBe("Linked text");
});
it("collects vetted images in order, deduplicates and skips code/unsafe media", () => {
  const preview = bodyPreview(
    `![One](${image})\n\n![again][same]\n\n[same]: ${image}\n\n<img src='${image}?second' onerror='bad()'>\n\n\`![Not media](${image}?code)\`\n\n![unsafe](javascript:bad)\n\n![other](https://example.test/other.png)`,
    undefined,
    base,
  );
  expect(preview.images).toEqual([image, `${image}?second`]);
  expect(document.querySelector("img, script")).toBeNull();
});
it("has useful image-only, empty and bounded fallbacks", () => {
  expect(bodyPreview(`![One](${image})`, undefined, base)).toEqual({
    text: "Images attached",
    images: [image],
  });
  expect(bodyPreview("", undefined, base)).toEqual({ text: "", images: [] });
  expect(
    bodyPreview("x".repeat(MAX_MARKDOWN_LENGTH + 1), undefined, base),
  ).toEqual({ text: "Long message · expand to read", images: [] });
  expect(bodyPreview(`${"> ".repeat(110)}too deep`, undefined, base).text).toBe(
    "Long message · expand to read",
  );
});

it("previews supported image attachment links using renderer metadata, not their file suffix alone", () => {
  const asset =
    "https://github.com/user-attachments/assets/81e77cff-0e61-4694-9a88-add0c1f997e4";
  expect(
    bodyPreview(`[Screenshot](${asset})`, `<img src="${asset}">`, base).images,
  ).toEqual([asset]);
  expect(
    bodyPreview(`[Video](${asset})`, `<video src="${asset}"></video>`, base)
      .images,
  ).toEqual([]);
});

it("allows rendered line measurement for text in any format without mounting hidden media", () => {
  for (const body of [
    "",
    "A **formatted** note",
    "A [linked note](https://example.test)",
    "`Code` and ~~edits~~",
    "One\nTwo",
    "First\n\nSecond",
    "# Heading",
    "- First\n- Second",
    "<div>HTML body</div>",
  ]) {
    expect(isTextBody(body, undefined, base)).toBe(true);
  }
  for (const body of [
    `![Image](${image})`,
    `[Image](${image})`,
    `<img src="${image}">`,
    `<a href="${image}">Image</a>`,
  ]) {
    expect(isTextBody(body, undefined, base)).toBe(false);
  }
});
