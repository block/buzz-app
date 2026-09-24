import {
  Fragment,
  type Mark,
  type Node as EditorNode,
} from "prosemirror-model";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmStrikethroughFromMarkdown } from "mdast-util-gfm-strikethrough";
import { gfmStrikethrough } from "micromark-extension-gfm-strikethrough";
import type { PhrasingContent } from "mdast";
import { composerSchema as schema } from "./composer-document";
import { messageLinkParts } from "./message-link-parts";

/** Adopt a source link only when explicitly editing it; preserve its label marks. */
export function composerLinkLabel(
  source: string,
  marks: readonly Mark[],
): Fragment {
  const tree = fromMarkdown(source, {
    extensions: [gfmStrikethrough()],
    mdastExtensions: [gfmStrikethroughFromMarkdown()],
  });
  const paragraph = tree.children[0];
  const link =
    paragraph?.type === "paragraph" && paragraph.children.length === 1
      ? paragraph.children[0]
      : undefined;
  const read = (
    nodes: readonly PhrasingContent[],
    active: readonly Mark[],
  ): EditorNode[] =>
    nodes.flatMap((node) => {
      if (node.type === "text" || node.type === "inlineCode")
        return node.value
          ? [
              schema.text(
                node.value,
                node.type === "inlineCode"
                  ? schema.marks.code.create().addToSet(active)
                  : active,
              ),
            ]
          : [];
      const name =
        node.type === "strong"
          ? "bold"
          : node.type === "emphasis"
            ? "italic"
            : node.type === "delete"
              ? "strike"
              : undefined;
      if ("children" in node)
        return read(
          node.children,
          name ? schema.marks[name].create().addToSet(active) : active,
        );
      if (node.type === "image")
        return node.alt ? [schema.text(node.alt, active)] : [];
      return [];
    });
  return link?.type === "link"
    ? Fragment.fromArray(read(link.children, marks))
    : Fragment.from(
        schema.text(
          messageLinkParts(source)
            .map((part) => part.text)
            .join(""),
          marks,
        ),
      );
}
