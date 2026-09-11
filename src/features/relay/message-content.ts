import { fromMarkdown } from "mdast-util-from-markdown";

export const MAX_MARKDOWN_LENGTH = 100_000;
export const MAX_MARKDOWN_DEPTH = 100;

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

type MarkdownScan = {
  tree: MarkdownNode;
  tooDeep: boolean;
  definitions: Map<string, string>;
  images: MarkdownNode[];
};

/** Parse once and bound attacker-controlled nesting before recursive render stages. */
export function scanMarkdown(content: string): MarkdownScan {
  const tree = fromMarkdown(content) as MarkdownNode;
  const definitions = new Map<string, string>();
  const images: MarkdownNode[] = [];
  const pending = [{ node: tree, depth: 0 }];
  let tooDeep = false;
  while (pending.length) {
    const current = pending.pop();
    if (!current) continue;
    const { node, depth } = current;
    if (depth > MAX_MARKDOWN_DEPTH) {
      tooDeep = true;
      continue;
    }
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
      if (child) pending.push({ node: child, depth: depth + 1 });
    }
  }
  return { tree, tooDeep, definitions, images };
}

export function markdownIsSafeToRender(content: string): boolean {
  return (
    content.length <= MAX_MARKDOWN_LENGTH && !scanMarkdown(content).tooDeep
  );
}

/** Project every CommonMark image from the same bounded parse policy as rendering. */
export function projectMarkdownImages(content: string): {
  content: string;
  urls: readonly string[];
} {
  const { tooDeep, definitions, images } = scanMarkdown(content);
  if (tooDeep) return { content, urls: Object.freeze([]) };

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
