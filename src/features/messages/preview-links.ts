import { scanMarkdown } from "../relay/message-content";
import { prepareMarkdown } from "./markdown-preparation";
import { messageLinkParts } from "./message-link-parts";

type Node = {
  type: string;
  url?: string;
  value?: string;
  children?: Node[] | undefined;
  position?: { start: { offset?: number }; end: { offset?: number } };
};

const skipped = new Set([
  "code",
  "inlineCode",
  "html",
  "definition",
  "image",
  "imageReference",
  "linkReference",
]);

const https = (value: string) => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
};

/** The HTTPS links a message's prose names, in order, once each: bare and
 * labeled links, but not `<url>`, which asks for no preview, nor links in
 * code or naming one of `exclude`. */
export function previewLinks(
  content: string,
  exclude: readonly string[] = [],
): readonly string[] {
  const prepared = prepareMarkdown(content);
  if (prepared.kind === "plain" || !content.includes("https://")) return [];
  const scan = scanMarkdown(prepared.content);
  if (scan.tooDeep) return [];
  const source = prepared.content;
  const excluded = new Set(exclude.map((url) => https(url) ?? url));
  const found: string[] = [];
  const add = (raw: string) => {
    const url = https(raw);
    if (url && !excluded.has(url) && !found.includes(url)) found.push(url);
  };
  const visit = (node: Node) => {
    if (skipped.has(node.type)) return;
    if (node.type === "link") {
      const start = node.position?.start.offset;
      if (start !== undefined && source[start] !== "<" && node.url)
        add(node.url);
      return;
    }
    if (node.type === "text" && node.value)
      messageLinkParts(node.value, undefined, (start, end, url) => {
        if (node.value?.[start] !== "<" && end > start) add(url);
      });
    for (const child of node.children ?? []) visit(child);
  };
  visit(scan.tree as Node);
  return found;
}
