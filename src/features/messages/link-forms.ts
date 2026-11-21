import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

import type { LinkWritten } from "../conversation/contracts";

type LinkNode = {
  type: string;
  value?: string;
  url?: string;
  children?: LinkNode[];
  position?: { start: { offset?: number }; end: { offset?: number } };
  data?: { hProperties?: Record<string, string> };
};

/** One link occurrence by its address as written in the message source, which
 * may differ from the address the host opens, and its place among the links
 * that share that written address, in reading order. */
export type LinkTarget = Readonly<{
  url: string;
  written: LinkWritten;
  occurrence: number;
}>;

export type WrittenLink = LinkTarget &
  Readonly<{
    node: LinkNode;
    start: number;
    end: number;
  }>;

/** Links the Markdown parser found in `source`, the string it parsed. Code spans
 * and blocks hold no link nodes, so they are never listed. */
export function writtenLinks(tree: LinkNode, source: string): WrittenLink[] {
  const seen = new Map<string, number>();
  const links: WrittenLink[] = [];
  const visit = (node: LinkNode) => {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (
      node.type === "link" &&
      node.url !== undefined &&
      start !== undefined &&
      end !== undefined
    ) {
      const occurrence = seen.get(node.url) ?? 0;
      seen.set(node.url, occurrence + 1);
      const first = source[start];
      links.push({
        node,
        url: node.url,
        written: first === "<" ? "angle" : first === "[" ? "labeled" : "bare",
        occurrence,
        start,
        end,
      });
      return;
    }
    for (const child of node.children ?? []) visit(child);
  };
  visit(tree);
  return links;
}

/** Hands each link's written address, form and position to the anchor renderer
 * as `data-link-*`. */
export function remarkLinkForms(source: string) {
  return (tree: LinkNode) => {
    for (const { node, url, written, occurrence } of writtenLinks(tree, source))
      node.data = {
        ...node.data,
        hProperties: {
          ...node.data?.hProperties,
          "data-link-source": url,
          "data-link-written": written,
          "data-link-occurrence": String(occurrence),
        },
      };
  };
}

function parsedLinks(source: string): WrittenLink[] {
  let tree: LinkNode | undefined;
  Markdown({
    remarkPlugins: [
      remarkGfm,
      () => (root: LinkNode) => {
        tree = root;
      },
    ],
    skipHtml: true,
    urlTransform: (value) => value,
    children: source,
  });
  return tree ? writtenLinks(tree, source) : [];
}

/** `source` with exactly one occurrence of a link rewritten to `<url>`, which
 * asks for no preview, or undefined when it is not there as described or
 * cannot be written that way. */
export function angleLink(
  source: string,
  link: LinkTarget,
): string | undefined {
  const match = parsedLinks(source).find(
    (item) =>
      item.url === link.url &&
      item.occurrence === link.occurrence &&
      item.written === link.written,
  );
  if (!match || match.written === "angle") return undefined;
  const [label] = match.node.children ?? [];
  if (
    match.written === "labeled" &&
    (match.node.children?.length !== 1 ||
      label?.type !== "text" ||
      label.value !== match.url)
  )
    return undefined;
  const text = source.slice(match.start, match.end);
  const target = /^[a-z][a-z\d+.-]*:/i.test(text) ? text : match.url;
  return /[\s<>]/.test(target)
    ? undefined
    : `${source.slice(0, match.start)}<${target}>${source.slice(match.end)}`;
}

/** The link in `source` that begins at `at` and opens `url`, as `angleLink`
 * names it. */
export function linkAt(
  source: string,
  at: number,
  opens: (url: string) => boolean,
): LinkTarget | undefined {
  const match = parsedLinks(source).find(
    (item) => item.start === at && opens(item.url),
  );
  return (
    match && {
      url: match.url,
      written: match.written,
      occurrence: match.occurrence,
    }
  );
}
