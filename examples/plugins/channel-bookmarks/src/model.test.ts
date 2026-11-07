import { expect, it } from "vitest";
import { bookmark, readBookmarks, writeBookmarks } from "./model";

it("preserves other Canvas sections and CRLF through add, edit, reorder, and removal", () => {
  const prefix = "# Notes\r\nKeep this prose.  \r\n\r\n";
  const suffix = "## Todos\r\n- [ ] Ship\r\n";
  const content = `${prefix}## Channel bookmarks\r\n\r\n- [Docs](https://example.com/docs)\r\n\r\n${suffix}`;
  const first = bookmark(
    "[API] & `reference`",
    "https://example.com/api?q=(hi)",
  );
  const second = bookmark("Docs", "https://example.com/docs");
  const changed = writeBookmarks(content, [first, second]);
  expect(changed.startsWith(prefix)).toBe(true);
  expect(changed.endsWith(suffix)).toBe(true);
  expect(readBookmarks(changed).items).toEqual([first, second]);
  expect(readBookmarks(writeBookmarks(changed, [second, first])).items).toEqual(
    [second, first],
  );
  expect(readBookmarks(writeBookmarks(changed, [])).items).toEqual([]);
});

it("adds a section to an empty Canvas and rejects incomplete Markdown or unfamiliar section content", () => {
  const item = bookmark("Docs", "https://example.com");
  expect(readBookmarks(writeBookmarks("", [item])).items).toEqual([item]);
  for (const content of [
    "```unfinished\n",
    "## Channel bookmarks\nProse that must not be erased.\n",
    "## Channel bookmarks\n\n## Channel bookmarks\n",
    "## Channel bookmarks\n- [Docs](https://example.com) extra\n",
    "## Channel bookmarks\n- [Docs](https://example.com)\n  - [Nested](https://example.org)\n",
  ])
    expect(() => writeBookmarks(content, [item])).toThrow();
});

it("rejects unsafe destinations, empty names, multiline names, and duplicate URLs", () => {
  for (const url of [
    "javascript:alert(1)",
    "data:text/html,hi",
    "https://user:pass@example.com",
    "relative/path",
  ])
    expect(() => bookmark("Docs", url)).toThrow();
  expect(() => bookmark(" ", "https://example.com")).toThrow();
  expect(() => bookmark("A\nB", "https://example.com")).toThrow();
  expect(() =>
    writeBookmarks("", [
      bookmark("A", "https://example.com"),
      bookmark("B", "https://example.com"),
    ]),
  ).toThrow();
});
