import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmStrikethrough } from "micromark-extension-gfm-strikethrough";
import { gfmStrikethroughFromMarkdown } from "mdast-util-gfm-strikethrough";
import { gfmTable } from "micromark-extension-gfm-table";
import { gfmTableFromMarkdown } from "mdast-util-gfm-table";
import type { Mark, Node as EditorNode } from "prosemirror-model";
import type { RootContent } from "mdast";
import {
  composerSchema as schema,
  projectComposerDocument,
} from "./composer-document";
import { composerLinkUrl } from "./composer-link";
import { mentionDraft } from "./mention-draft";
import { MAX_MARKDOWN_LENGTH, scanMarkdown } from "../relay/message-content";

/** Use the existing editor schema; unsupported syntax remains editable source. */
export function documentEditorDraft(markdown: string) {
  if (markdown.length > MAX_MARKDOWN_LENGTH) return mentionDraft(markdown);
  const scan = scanMarkdown(markdown);
  const { tooDeep } = scan;
  if (tooDeep) return mentionDraft(markdown);
  const tree = fromMarkdown(markdown, {
    extensions: [gfmStrikethrough(), gfmTable()],
    mdastExtensions: [gfmStrikethroughFromMarkdown(), gfmTableFromMarkdown()],
  });
  const raw = (node: RootContent) =>
    markdown.slice(
      node.position?.start.offset ?? 0,
      node.position?.end.offset ?? 0,
    );
  const text = (value: string, marks: readonly Mark[] = []) =>
    value ? [schema.text(value, marks)] : [];
  const inline = (
    node: RootContent,
    marks: readonly Mark[] = [],
  ): EditorNode[] => {
    if (node.type === "text")
      return text(
        node.value,
        raw(node) === node.value
          ? marks
          : [...marks, schema.marks.literal.create()],
      );
    if (node.type === "inlineCode")
      return marks.length
        ? text(raw(node), marks)
        : text(node.value, [schema.marks.code.create()]);
    if (node.type === "break") return [schema.nodes.hard_break.create()];
    const mark =
      node.type === "strong"
        ? schema.marks.bold
        : node.type === "emphasis"
          ? schema.marks.italic
          : node.type === "delete"
            ? schema.marks.strike
            : undefined;
    if (mark && "children" in node)
      return node.children.flatMap((child) =>
        inline(child, [...marks, mark.create()]),
      );
    if (node.type === "link" && composerLinkUrl(node.url))
      return node.children.flatMap((child) =>
        inline(child, [...marks, schema.marks.link.create({ href: node.url })]),
      );
    return text(raw(node), marks);
  };
  const block = (node: RootContent): EditorNode => {
    if (node.type === "paragraph")
      return schema.nodes.paragraph.create(
        null,
        node.children.flatMap((child) => inline(child)),
      );
    if (node.type === "code")
      return schema.nodes.code_block.create(
        { language: node.lang ?? null },
        text(node.value),
      );
    if (node.type === "blockquote")
      return schema.nodes.blockquote.create(
        null,
        node.children.length
          ? node.children.map(block)
          : schema.nodes.paragraph.create(),
      );
    if (
      node.type === "list" &&
      !node.children.some(
        (item) =>
          item.checked != null || item.children[0]?.type !== "paragraph",
      ) &&
      !/^\s*[-*+]\s+\[[ xX]\]/m.test(raw(node))
    )
      return schema.nodes[node.ordered ? "ordered_list" : "bullet_list"].create(
        node.ordered ? { order: node.start ?? 1 } : null,
        node.children.map((item) =>
          schema.nodes.list_item.create(null, item.children.map(block)),
        ),
      );
    return schema.nodes.paragraph.create(null, text(raw(node)));
  };
  // The source adapter uses single newlines between paragraph nodes.
  const blocks: EditorNode[] = [];
  for (const [index, node] of tree.children.entries()) {
    const converted = block(node);
    const previous = tree.children[index - 1];
    if (
      previous &&
      converted.type === schema.nodes.paragraph &&
      blocks.at(-1)?.type === schema.nodes.paragraph
    ) {
      const gap = markdown.slice(
        previous.position?.end.offset ?? 0,
        node.position?.start.offset ?? 0,
      );
      for (let breaks = (gap.match(/\n/g) ?? []).length; breaks > 1; breaks--)
        blocks.push(schema.nodes.paragraph.create());
    }
    blocks.push(converted);
  }
  const doc = schema.nodes.doc.create(
    null,
    blocks.length ? blocks : schema.nodes.paragraph.create(),
  );
  doc.check();
  return projectComposerDocument(doc).draft;
}
