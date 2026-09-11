import { fromMarkdown } from "mdast-util-from-markdown";

export const MAX_MARKDOWN_LENGTH = 100_000;

export function safeMessageUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}

type MarkdownNode = {
  type: string;
  url?: string;
  identifier?: string;
  children?: MarkdownNode[];
  position?: { start: { offset?: number }; end: { offset?: number } };
};

/**
 * Project CommonMark images from signed prose without maintaining a second image regex.
 * Definitions are collected before references so source order does not affect resolution.
 */
export function projectMarkdownImages(content: string): {
  content: string;
  urls: readonly string[];
} {
  const tree = fromMarkdown(content) as MarkdownNode;
  const definitions = new Map<string, string>();
  const images: MarkdownNode[] = [];
  // Markdown nesting is attacker-controlled. An explicit stack avoids exhausting
  // the JavaScript call stack on a valid, deeply nested relay message.
  const pending = [tree];
  while (pending.length) {
    const node = pending.pop();
    if (!node) continue;
    if (
      node.type === "definition" &&
      typeof node.identifier === "string" &&
      typeof node.url === "string" &&
      !definitions.has(node.identifier.toLowerCase())
    )
      definitions.set(node.identifier.toLowerCase(), node.url);
    if (node.type === "image" || node.type === "imageReference")
      images.push(node);
    for (let index = (node.children?.length ?? 0) - 1; index >= 0; index--) {
      const child = node.children?.[index];
      if (child) pending.push(child);
    }
  }

  const urls: string[] = [];
  const seen = new Set<string>();
  const ranges: Array<{ start: number; end: number }> = [];
  for (const image of images) {
    const raw =
      image.type === "image"
        ? image.url
        : typeof image.identifier === "string"
          ? definitions.get(image.identifier.toLowerCase())
          : undefined;
    const url = raw ? safeMessageUrl(raw) : undefined;
    if (url && !seen.has(url)) {
      seen.add(url);
      urls.push(url);
    }
    const start = image.position?.start.offset;
    const end = image.position?.end.offset;
    if (typeof start === "number" && typeof end === "number")
      ranges.push({ start, end });
  }

  let stripped = content;
  for (const range of ranges.sort((a, b) => b.start - a.start))
    stripped = stripped.slice(0, range.start) + stripped.slice(range.end);
  return { content: stripped.trim(), urls: Object.freeze(urls) };
}
