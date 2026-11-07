import { fromMarkdown } from "mdast-util-from-markdown";
function safeLinkUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) &&
      !url.username &&
      !url.password
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}

export type Bookmark = Readonly<{ label: string; url: string }>;
const headingText = "Channel bookmarks";

export function bookmark(label: string, url: string): Bookmark {
  const target = safeLinkUrl(url.trim());
  if (!label.trim() || /[\r\n]/.test(label))
    throw new Error("Enter a bookmark name on one line.");
  if (!target)
    throw new Error("Enter an HTTP or HTTPS URL without credentials.");
  return { label: label.trim(), url: target };
}

/** Only a plain link list belongs to this section; never erase unfamiliar prose. */
export function readBookmarks(content: string) {
  const nodes = fromMarkdown(content).children;
  const headings = nodes.filter(
    (node) =>
      node.type === "heading" &&
      node.depth === 2 &&
      node.children.length === 1 &&
      node.children[0]?.type === "text" &&
      node.children[0].value === headingText,
  );
  if (headings.length > 1)
    throw new Error("Keep one ## Channel bookmarks section in Canvas.");
  const heading = headings[0];
  const following = heading ? nodes.slice(nodes.indexOf(heading) + 1) : [];
  const boundary = following.findIndex(
    (node) => node.type === "heading" && node.depth <= 2,
  );
  const section = boundary < 0 ? following : following.slice(0, boundary);
  const items: Bookmark[] = [];
  for (const node of section) {
    if (node.type !== "list" || node.ordered)
      throw new Error(
        "Use only a bullet list of links in Canvas’s Channel bookmarks section.",
      );
    for (const item of node.children) {
      const paragraph = item.children[0];
      const link =
        paragraph?.type === "paragraph" ? paragraph.children[0] : undefined;
      if (
        item.children.length !== 1 ||
        paragraph?.type !== "paragraph" ||
        paragraph.children.length !== 1 ||
        link?.type !== "link" ||
        link.title ||
        link.children.length !== 1 ||
        link.children[0]?.type !== "text"
      )
        throw new Error(
          "Use named links such as - [Docs](https://example.com) in the Channel bookmarks section.",
        );
      items.push(bookmark(link.children[0].value, link.url));
    }
  }
  if (new Set(items.map((item) => item.url)).size !== items.length)
    throw new Error("Each bookmark URL must appear only once.");
  return {
    items,
    start: heading?.position?.end.offset,
    end:
      boundary < 0
        ? content.length
        : (following[boundary]?.position?.start.offset ?? content.length),
  };
}

export function writeBookmarks(content: string, items: readonly Bookmark[]) {
  const { start, end } = readBookmarks(content);
  const newline = content.includes("\r\n") ? "\r\n" : "\n";
  const lines = items
    .map((item) => {
      const checked = bookmark(item.label, item.url);
      const label = checked.label.replace(/[\\`*_{}[\]()#+\-.!<>|&]/g, "\\$&");
      const url = checked.url.replace(/[<>\\]/g, (char) =>
        encodeURIComponent(char),
      );
      return `- [${label}](<${url}>)`;
    })
    .join(newline);
  const next =
    start === undefined
      ? `${content}${content ? newline + newline : ""}## ${headingText}${newline}${newline}${lines}${newline}`
      : `${content.slice(0, start)}${newline}${newline}${lines}${newline}${newline}${content.slice(end)}`;
  if (
    JSON.stringify(readBookmarks(next).items) !==
    JSON.stringify(items.map((item) => bookmark(item.label, item.url)))
  )
    throw new Error(
      "Could not update bookmarks safely. Check Canvas for unfinished Markdown blocks.",
    );
  return next;
}
