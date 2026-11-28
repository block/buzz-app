import { scanMarkdown } from "../relay/message-content";
import { preparedMarkdown, recentResults } from "./markdown-preparation";
import { messageLinkParts } from "./message-link-parts";

type Node = {
  type: string;
  url?: string;
  identifier?: string;
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
]);

export const httpsUrl = (value: string) => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
};

export type PreviewLink = Readonly<{
  url: string;
  /** Where in `content` the link that earned the card begins, when it is
   * written so that rewriting it to `<url>` keeps all the author wrote. */
  at?: number | undefined;
}>;

/** The HTTPS links a message's prose names, in order, once each: bare,
 * labeled and reference links, but not `<url>`, which asks for no preview,
 * nor links in code or spoilers, nor ones naming one of `exclude`. */
export function previewLinks(
  content: string,
  exclude: readonly string[] = [],
): readonly string[] {
  return previewCards(content, exclude).map((link) => link.url);
}

export function previewCards(
  content: string,
  exclude: readonly string[] = [],
): readonly PreviewLink[] {
  if (!/https:\/\//i.test(content)) return [];
  const key = JSON.stringify([content, exclude]);
  return recentLinks(key, () => findPreviewLinks(content, exclude));
}

// Rows remount on every channel switch and scroll; a revisit reuses its links.
const recentLinks = recentResults<readonly PreviewLink[]>(
  200_000,
  (key, links) =>
    100 + key.length + links.reduce((sum, link) => sum + link.url.length, 0),
);

function findPreviewLinks(
  content: string,
  exclude: readonly string[],
): readonly PreviewLink[] {
  // A fresh preparation hands over its scan, so the body is parsed once.
  let made: ReturnType<typeof scanMarkdown> | undefined;
  const prepared = preparedMarkdown(content, (scan) => {
    made = scan;
  });
  if (prepared.kind === "plain") return [];
  const scan = made ?? scanMarkdown(prepared.content);
  if (scan.tooDeep) return [];
  const source = prepared.content;
  const delimiters = prepared.spoilerDelimiters;
  const excluded = new Set(exclude.map((url) => httpsUrl(url) ?? url));
  const found: PreviewLink[] = [];
  const add = (raw: string | undefined, at?: number) => {
    const url = raw && httpsUrl(raw);
    if (url && !excluded.has(url) && !found.some((link) => link.url === url))
      found.push({ url, at: source === content ? at : undefined });
  };
  const span = (node: Node) => [
    node.position?.start.offset,
    node.position?.end.offset,
  ];
  // Spoilers pair `||` among one parent's text children, as remarkSpoilers does.
  const hiddenRanges = (children: readonly Node[]) => {
    const own = children.flatMap((child) => {
      const [start, end] = span(child);
      return child.type === "text" && start !== undefined && end !== undefined
        ? delimiters.filter((at) => at >= start && at + 2 <= end)
        : [];
    });
    const ranges: [number, number][] = [];
    for (let i = 0; i + 1 < own.length; i += 2)
      ranges.push([own[i] ?? 0, (own[i + 1] ?? 0) + 2]);
    return ranges;
  };
  const visit = (node: Node, hidden: readonly [number, number][]) => {
    if (skipped.has(node.type)) return;
    const [start, end] = span(node);
    const inside = (at: number) =>
      hidden.some(([from, to]) => at >= from && at < to);
    if (node.type === "link" || node.type === "linkReference") {
      if (start === undefined || source[start] === "<" || inside(start)) return;
      const [label] = node.children ?? [];
      add(
        node.type === "link"
          ? node.url
          : scan.definitions.get(node.identifier?.toLowerCase() ?? ""),
        node.type === "link" &&
          node.children?.length === 1 &&
          label?.type === "text" &&
          label.value === node.url
          ? start
          : undefined,
      );
      return;
    }
    if (node.type === "text") {
      if (start === undefined || end === undefined || !node.value) return;
      const text = hidden.length ? source.slice(start, end) : node.value;
      const exact = text === source.slice(start, end);
      messageLinkParts(text, undefined, (from, to, url) => {
        if (text[from] !== "<" && to > from && !inside(start + from))
          add(url, exact ? start + from : undefined);
      });
      return;
    }
    const children = node.children ?? [];
    const own = hiddenRanges(children);
    for (const child of children) visit(child, own);
  };
  visit(scan.tree as Node, []);
  return Object.freeze(found);
}
