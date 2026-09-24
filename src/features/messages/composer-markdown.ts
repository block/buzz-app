import { spoilerMarkdown } from "./remark-spoilers";
import {
  toMarkdown,
  defaultHandlers,
  type Handle,
} from "mdast-util-to-markdown";
import { fromMarkdown } from "mdast-util-from-markdown";
import {
  gfmStrikethroughFromMarkdown,
  gfmStrikethroughToMarkdown,
} from "mdast-util-gfm-strikethrough";
import { gfmStrikethrough } from "micromark-extension-gfm-strikethrough";
import type { PhrasingContent, Root, Text } from "mdast";
import type { MentionDraft } from "./mention-draft";
import type { Node as EditorNode } from "prosemirror-model";
import {
  composerSchema,
  readComposerDocument,
  type SourceRange,
} from "./composer-document";

const strikethrough = gfmStrikethroughToMarkdown();
const deleteHandler = strikethrough.handlers?.delete;
// GFM's serializer omits the attention flanking hint supplied by CommonMark's
// strong/emphasis handlers. Punctuation-only strike needs the same surrounding
// letter encoding (x~~!~~y otherwise renders as literal tildes).
const strike: Handle & { peek?: Handle } = (node, parent, state, info) => {
  if (!deleteHandler)
    throw new Error("GFM strikethrough serializer is required");
  const value = deleteHandler(node, parent, state, info);
  const needsEncoding = (outside: string, inside: string) =>
    !!outside &&
    !/[\s\p{P}\p{S}]/u.test(outside) &&
    /[\p{P}\p{S}]/u.test(inside);
  state.attentionEncodeSurroundingInfo = {
    before: needsEncoding(info.before.slice(-1), value.slice(2, 3)),
    after: needsEncoding(info.after.slice(0, 1), value.slice(-3, -2)),
  };
  return value;
};
strike.peek = () => "~";

/** Plain portions are authored Markdown, not rich-editor literal text. Keeping
 * their source verbatim avoids normalizing formats this slice does not edit.
 * Marked content uses CommonMark/GFM delimiter escaping and flanking rules. */
export function composerMarkdown(draft: MentionDraft): string {
  const doc = readComposerDocument(draft, []);
  return blocksMarkdown(doc);
}

function blocksMarkdown(doc: EditorNode): string {
  const blocks: string[] = [];
  let previous: EditorNode | undefined;
  doc.forEach((block) => {
    // Blank separation prevents lazy quote continuation and adjacent blocks
    // merging on send; ordinary authored paragraph newlines remain unchanged.
    if (previous)
      blocks.push(
        previous.type.name === "paragraph" && block.type.name === "paragraph"
          ? "\n"
          : "\n\n",
      );
    if (block.type.name === "code_block") {
      blocks.push(
        toMarkdown(
          {
            type: "root",
            children: [{ type: "code", value: block.textContent }],
          },
          { fences: true },
        ).slice(0, -1),
      );
    } else if (block.type.name === "blockquote") {
      blocks.push(
        blocksMarkdown(block)
          .split("\n")
          .map((line) => (line ? `> ${line}` : ">"))
          .join("\n"),
      );
    } else if (
      block.type.name === "bullet_list" ||
      block.type.name === "ordered_list"
    ) {
      const items: string[] = [];
      block.forEach((item, _offset, index) => {
        const prefix =
          block.type.name === "ordered_list"
            ? `${block.attrs.order + index}. `
            : "- ";
        const lines = blocksMarkdown(item).split("\n");
        items.push(
          prefix +
            lines
              .map((line, index) =>
                index ? " ".repeat(prefix.length) + line : line,
              )
              .join("\n"),
        );
      });
      blocks.push(items.join("\n"));
    } else blocks.push(paragraphMarkdown(block));
    previous = block;
  });
  return blocks.join("");
}

function paragraphMarkdown(block: EditorNode): string {
  let text = "";
  const formats = [
    { mark: composerSchema.marks.spoiler, type: "spoiler" },
    { mark: composerSchema.marks.link, type: "link" },
    { mark: composerSchema.marks.bold, type: "strong" },
    { mark: composerSchema.marks.italic, type: "emphasis" },
    { mark: composerSchema.marks.strike, type: "delete" },
    { mark: composerSchema.marks.code, type: "inlineCode" },
  ] as const;
  const ranges: (SourceRange & { href?: string })[][] = formats.map(() => []);
  const literals: SourceRange[] = [];
  block.forEach((node) => {
    const start = text.length;
    text += node.isText
      ? node.textContent
      : node.type.name === "hard_break"
        ? "\n"
        : node.attrs.source;
    if (composerSchema.marks.literal.isInSet(node.marks))
      literals.push({ start, end: text.length });
    formats.forEach(({ mark }, index) => {
      const active = mark.isInSet(node.marks);
      if (!active) return;
      const href =
        mark === composerSchema.marks.link
          ? (active.attrs.href as string)
          : undefined;
      const spans = ranges[index];
      if (!spans) throw new RangeError("Missing composer format ranges");
      const previous = spans.at(-1);
      if (previous?.end === start && previous.href === href)
        previous.end = text.length;
      else spans.push({ start, end: text.length, ...(href ? { href } : {}) });
    });
  });
  // A spoiler is inline syntax. Close/reopen it across authored blank lines so
  // every resulting Markdown paragraph stays hidden after publication.
  ranges[0] = (ranges[0] ?? []).flatMap((range) => {
    const parts: SourceRange[] = [];
    let start = range.start;
    for (const match of text
      .slice(range.start, range.end)
      .matchAll(/\n[ \t]*\n/g)) {
      const end = range.start + match.index;
      if (end > start) parts.push({ start, end });
      start = end + match[0].length;
    }
    if (start < range.end) parts.push({ start, end: range.end });
    return parts;
  });
  if (!literals.length && ranges.every((spans) => !spans.length)) return text;
  const raw = new WeakSet<Text>();
  const literal = new WeakSet<Text>();
  const source = (
    start: number,
    end: number,
    marked: boolean,
    linked: boolean,
  ): PhrasingContent[] => {
    const value = text.slice(start, end);
    if (!value) return [];
    const boundaries = [
      ...new Set(
        literals
          .flatMap((range) => [range.start, range.end])
          .filter((point) => point > start && point < end),
      ),
    ].sort((a, b) => a - b);
    if (!linked && marked && boundaries.length) {
      const points = [start, ...boundaries, end];
      return points
        .slice(0, -1)
        .flatMap((point, index) =>
          source(point, points[index + 1] ?? end, marked, linked),
        );
    }
    const node: Text = { type: "text", value };
    if (!marked && !linked) {
      const points = [
        ...new Set([
          start,
          end,
          ...literals
            .flatMap((range) => [range.start, range.end])
            .filter((point) => point > start && point < end),
        ]),
      ].sort((a, b) => a - b);
      return points.slice(0, -1).map((from, index) => {
        const part: Text = {
          type: "text",
          value: text.slice(from, points[index + 1]),
        };
        (literals.some((range) => from >= range.start && from < range.end)
          ? literal
          : raw
        ).add(part);
        return part;
      });
    }
    // Linked labels use normal escaping, including mdast's autolink context.
    // Entity encoding is only for unlinked prose that must not become a URL.
    if (linked) return [node];
    if (literals.some((range) => start < range.end && end > range.start)) {
      literal.add(node);
      return [node];
    }
    // Existing inline Markdown inside a selection retains its meaning.
    const leading = value.length - value.trimStart().length;
    const trailing = value.trimEnd().length;
    if (leading >= trailing) return [node];
    const parsed = fromMarkdown(value.slice(leading, trailing), {
      extensions: [gfmStrikethrough()],
      mdastExtensions: [gfmStrikethroughFromMarkdown()],
    });
    const paragraph =
      parsed.children.length === 1 && parsed.children[0]?.type === "paragraph"
        ? parsed.children[0]
        : undefined;
    return [
      ...(leading
        ? [{ type: "text" as const, value: value.slice(0, leading) }]
        : []),
      ...(paragraph?.children ?? [
        { type: "text" as const, value: value.slice(leading, trailing) },
      ]),
      ...(trailing < value.length
        ? [{ type: "text" as const, value: value.slice(trailing) }]
        : []),
    ];
  };
  // A fixed nesting order makes overlapping marks a valid tree, splitting only
  // the crossing mark. Whitespace stays outside each generated delimiter pair,
  // while the editor document retains it (and its marks) for continued typing.
  const content = (
    start: number,
    end: number,
    depth: number,
    marked: boolean,
    linked = false,
  ): PhrasingContent[] => {
    const format = formats[depth];
    if (!format) return source(start, end, marked, linked);
    const children: PhrasingContent[] = [];
    let offset = start;
    for (const range of ranges[depth] ?? []) {
      const from = Math.max(start, range.start),
        to = Math.min(end, range.end);
      if (from >= to) continue;
      const value = text.slice(from, to);
      if (format.type === "inlineCode") {
        children.push(...source(offset, from, marked, linked));
        // CommonMark folds newlines inside a code span to spaces. Separate spans
        // preserve authored line breaks without inventing a fenced block.
        value.split("\n").forEach((line, index) => {
          if (index) children.push({ type: "text", value: "\n" });
          if (line) children.push({ type: "inlineCode", value: line });
        });
        offset = to;
        continue;
      }
      const first =
        format.type === "link"
          ? from
          : from + value.length - value.trimStart().length;
      const last = format.type === "link" ? to : from + value.trimEnd().length;
      if (first >= last) continue;
      children.push(...content(offset, first, depth + 1, marked, linked));
      const nested = content(
        first,
        last,
        depth + 1,
        true,
        linked || format.type === "link",
      );
      if (format.type === "link") {
        if (range.href === undefined)
          throw new Error("Link mark has no destination");
        children.push({ type: "link", url: range.href, children: nested });
      } else children.push({ type: format.type, children: nested });
      offset = last;
    }
    children.push(...content(offset, end, depth + 1, marked, linked));
    return children;
  };
  const rawText: Handle = (node, parent, state, info) => {
    if (node.type === "text" && raw.has(node)) {
      // Escape only the boundary ticks/backslash that could absorb a generated
      // code delimiter; unrelated authored Markdown remains byte-for-byte source.
      let value: string = node.value;
      if (info.before.endsWith("|"))
        value = value.replace(/^\|+/, (pipes) =>
          pipes.replaceAll("|", "&#124;"),
        );
      if (info.after.startsWith("|"))
        value = value.replace(/[|\\]+$/, (tail) =>
          tail.replace(/[|\\]/g, (char) => `&#${char.charCodeAt(0)};`),
        );
      if (info.before.endsWith("`"))
        value = value.replace(/^`+/, (ticks) => ticks.replaceAll("`", "\\`"));
      if (info.after.startsWith("`"))
        value = value.replace(/[`\\]+$/, (tail) =>
          tail.replace(/[\\`]/g, "\\$&"),
        );
      return value;
    }
    const value = defaultHandlers.text(node, parent, state, info);
    // Literal link labels must not become GFM/bare autolinks after unlinking.
    return node.type === "text" && literal.has(node)
      ? value.replace(/[:.@]/g, (char) => `&#${char.charCodeAt(0)};`)
      : value;
  };
  const tree: Root = {
    type: "root",
    children: [
      { type: "paragraph", children: content(0, text.length, 0, false) },
    ],
  };
  // Root adds exactly one final line ending; authored trailing newlines stay.
  return toMarkdown(tree, {
    extensions: [strikethrough],
    unsafe: [{ character: "|", inConstruct: "spoiler" }],
    handlers: { text: rawText, delete: strike, spoiler: spoilerMarkdown },
    strong: "*",
    emphasis: "_",
  }).slice(0, -1);
}
