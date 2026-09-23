import { MAX_MARKDOWN_LENGTH, scanMarkdown } from "../relay/message-content";
import { normalizeWrappedLinks } from "./message-link-parts";

export type LiteralRange = Readonly<{ start: number; end: number }>;
type MarkdownNode = {
  type: string;
  children?: MarkdownNode[];
  position?: { start: { offset?: number }; end: { offset?: number } };
};
export type PreparedMarkdown =
  | Readonly<{ kind: "plain"; content: string }>
  | Readonly<{
      kind: "markdown";
      content: string;
      literalRanges: readonly LiteralRange[];
    }>;

const literalContext = (type: string) =>
  [
    "code",
    "inlineCode",
    "link",
    "linkReference",
    "image",
    "imageReference",
    "definition",
    "html",
  ].includes(type);

function literalRanges(
  tree: MarkdownNode,
  includeLinks: boolean,
): readonly LiteralRange[] {
  const ranges: LiteralRange[] = [];
  const pending = [tree];
  while (pending.length) {
    const node = pending.pop();
    if (!node) continue;
    if (literalContext(node.type) && (includeLinks || node.type !== "link")) {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (start !== undefined && end !== undefined)
        ranges.push(Object.freeze({ start, end }));
      continue;
    }
    for (let index = (node.children?.length ?? 0) - 1; index >= 0; index--) {
      const child = node.children?.[index];
      if (child) pending.push(child);
    }
  }
  return Object.freeze(ranges);
}

/** Pure, immutable Markdown work whose lifetime is owned by the mounted body. */
export function prepareMarkdown(content: string): PreparedMarkdown {
  if (content.length > MAX_MARKDOWN_LENGTH)
    return Object.freeze({ kind: "plain", content });

  let scan = scanMarkdown(content);
  if (scan.tooDeep) return Object.freeze({ kind: "plain", content });

  const normalizationLiterals = literalRanges(scan.tree, false);
  const normalized = normalizeWrappedLinks(content, (start, end) =>
    normalizationLiterals.some(
      (range) => start < range.end && end > range.start,
    ),
  );
  if (normalized !== content) {
    scan = scanMarkdown(normalized);
    if (scan.tooDeep)
      return Object.freeze({ kind: "plain", content: normalized });
  }

  return Object.freeze({
    kind: "markdown",
    content: normalized,
    literalRanges: literalRanges(scan.tree, true),
  });
}
