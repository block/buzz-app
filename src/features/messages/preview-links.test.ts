import { describe, expect, it, vi } from "vitest";
import { scanMarkdown } from "../relay/message-content";
import { preparedMarkdown } from "./markdown-preparation";
import { previewCards, previewLinks } from "./preview-links";

vi.mock("../relay/message-content", async (actual) => {
  const module = await actual<typeof import("../relay/message-content")>();
  return { ...module, scanMarkdown: vi.fn(module.scanMarkdown) };
});

describe("previewLinks", () => {
  it("lists bare and labeled HTTPS links once each, in order", () => {
    expect(
      previewLinks(
        "See https://example.com/a, [docs](https://docs.example.com/) and https://example.com/a again.",
      ),
    ).toEqual(["https://example.com/a", "https://docs.example.com/"]);
  });

  it("skips angle links, code, images, other schemes and attachments", () => {
    expect(
      previewLinks(
        [
          "<https://quiet.example.com>",
          "`https://code.example.com`",
          "```\nhttps://block.example.com\n```",
          "![img](https://img.example.com/a.png)",
          "http://plain.example.com buzz://channel/abc",
          "https://files.example.com/a.pdf",
          "https://kept.example.com",
        ].join("\n\n"),
        ["https://files.example.com/a.pdf"],
      ),
    ).toEqual(["https://kept.example.com/"]);
  });

  it("keeps spoiler links hidden and shows the ones around them", () => {
    expect(
      previewLinks(
        [
          "||[twist](https://plot.example.com/twist)|| and https://after.example.com",
          "before ||https://bare.example.com/hidden|| https://shown.example.com",
          "*||https://emphasis.example.com||* https://also.example.com",
          "|| unclosed https://open.example.com",
        ].join("\n\n"),
      ),
    ).toEqual([
      "https://after.example.com/",
      "https://shown.example.com/",
      "https://also.example.com/",
      "https://open.example.com/",
    ]);
  });

  it("resolves reference links through their definitions", () => {
    expect(
      previewLinks(
        "[docs][guide], [Guide] and [missing][nope]\n\n[guide]: https://example.org/docs",
      ),
    ).toEqual(["https://example.org/docs"]);
  });

  it("reads the HTTPS scheme in any case", () => {
    expect(previewLinks("HTTPS://example.org/docs")).toEqual([
      "https://example.org/docs",
    ]);
  });

  it("finds nothing in prose without links", () => {
    expect(previewLinks("hello there")).toEqual([]);
  });

  it("scans a body once for its renderer and previews", () => {
    const content = "Read https://example.com/once and `code`.";
    vi.mocked(scanMarkdown).mockClear();
    expect(previewLinks(content)).toEqual(["https://example.com/once"]);
    expect(preparedMarkdown(content).kind).toBe("markdown");
    expect(previewLinks(content)).toEqual(["https://example.com/once"]);
    expect(scanMarkdown).toHaveBeenCalledTimes(1);
  });
});

describe("previewCards", () => {
  it("says where the link that earned each card begins", () => {
    const content =
      "See [https://a.example/](https://a.example/) and https://b.example/x, then https://b.example/x";
    expect(previewCards(content)).toEqual([
      { url: "https://a.example/", at: 4 },
      {
        url: "https://b.example/x",
        at: content.indexOf("https://b.example/x"),
      },
    ]);
  });

  it("names no position for a link that has a label of its own", () => {
    expect(previewCards("See [docs](https://a.example/)")).toEqual([
      { url: "https://a.example/", at: undefined },
    ]);
  });
});
