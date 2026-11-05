import type { Transaction } from "prosemirror-state";
import { EditorState, Selection } from "prosemirror-state";
import type { Mark, Node } from "prosemirror-model";
import type { Nodes } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmStrikethrough } from "micromark-extension-gfm-strikethrough";
import { gfmStrikethroughFromMarkdown } from "mdast-util-gfm-strikethrough";
import type { ComposerDraftSnapshot } from "../conversation/contracts";
import type { MentionDraft } from "./mention-draft";
import { composerSchema, projectComposerDocument } from "./composer-document";
import { composerLinkUrl } from "./composer-link";
import { composerMarkdown } from "./composer-markdown";

/** The editor owns both the snapshot evidence and mention provenance. */
export function createDraftRewriter(host: {
  state(): EditorState;
  revision(): number;
  editable(): boolean;
  maxLength(): number;
  document(draft: MentionDraft): Node;
  apply(tr: Transaction): boolean;
}) {
  type Held = {
    revision: number;
    doc: Node;
    markers: { marker: string; pubkey: string; name: string }[];
  };
  const held = new WeakMap<ComposerDraftSnapshot, Held>();
  return {
    read(): ComposerDraftSnapshot | null {
      if (!host.editable()) return null;
      const state = host.state();
      const source = projectComposerDocument(state.doc);
      if (source.draft.pending?.length) return null;
      const nonce = crypto.randomUUID();
      const markers = source.draft.recipients.map((person, index) => ({
        marker: `BUZZMENTION${nonce.replaceAll("-", "")}X${index}END`,
        pubkey: person.pubkey,
        name: person.name,
      }));
      // Serialize rich formatting after replacing identity spans with opaque text.
      const tr = state.tr;
      for (let index = markers.length - 1; index >= 0; index--) {
        const person = source.draft.recipients[index];
        const marker = markers[index];
        if (!person || !marker) return null;
        const from = source.position(person.start);
        tr.replaceWith(
          from,
          source.position(person.end, -1),
          composerSchema.text(
            marker.marker,
            state.doc
              .resolve(from)
              .nodeAfter?.marks.filter(
                (mark) => mark.type !== composerSchema.marks.recipient,
              ),
          ),
        );
      }
      const snapshot = Object.freeze({
        text: composerMarkdown(projectComposerDocument(tr.doc).draft),
        mentions: Object.freeze(
          markers.map(({ marker, name }) => Object.freeze({ marker, name })),
        ),
      });
      held.set(snapshot, {
        revision: host.revision(),
        doc: state.doc,
        markers,
      });
      return snapshot;
    },
    replace(snapshot: ComposerDraftSnapshot, text: string): boolean {
      const saved = held.get(snapshot);
      if (
        !saved ||
        !host.editable() ||
        saved.revision !== host.revision() ||
        saved.doc !== host.state().doc ||
        typeof text !== "string" ||
        !text.trim() ||
        text.length > host.maxLength() + saved.markers.length * 100
      )
        return false;
      const positions = saved.markers.map((person) => ({
        ...person,
        at: text.indexOf(person.marker),
      }));
      if (
        positions.some(
          ({ marker, at }) =>
            at < 0 || text.indexOf(marker, at + marker.length) >= 0,
        )
      )
        return false;
      positions.sort((a, b) => a.at - b.at);
      // An unchanged result retains exact whitespace, unsupported syntax, and
      // host-owned metadata rather than normalizing the original document.
      const parsed = text === snapshot.text ? saved.doc : rewriteDocument(text);
      if (!parsed) return false;
      const source = projectComposerDocument(parsed);
      const tr = EditorState.create({ doc: parsed }).tr;
      for (const person of text === snapshot.text
        ? []
        : [...positions].reverse()) {
        const at = source.draft.text.indexOf(person.marker);
        if (
          at < 0 ||
          source.draft.text.indexOf(person.marker, at + person.marker.length) >=
            0
        )
          return false;
        const from = source.position(at);
        const marks = parsed.resolve(from).nodeAfter?.marks ?? [];
        tr.replaceWith(
          from,
          source.position(at + person.marker.length, -1),
          composerSchema.text(`@${person.name}`, [
            ...marks,
            composerSchema.marks.recipient.create({
              pubkey: person.pubkey,
              name: person.name,
            }),
          ]),
        );
      }
      const draft = projectComposerDocument(tr.doc).draft;
      if (draft.text.includes("BUZZMENTION")) return false;
      const doc = host.document(draft);
      if (
        composerMarkdown(projectComposerDocument(doc).draft).length >
        host.maxLength()
      )
        return false;
      // Revalidate provenance after parsing. A rewrite cannot drop or invent intent.
      const actual = projectComposerDocument(doc).draft.recipients;
      if (
        actual.length !== positions.length ||
        actual.some(
          (person, index) => person.pubkey !== positions[index]?.pubkey,
        )
      )
        return false;
      const replacement = host
        .state()
        .tr.replaceWith(0, host.state().doc.content.size, doc.content);
      replacement.setSelection(Selection.atEnd(replacement.doc));
      if (!host.apply(replacement)) return false;
      held.delete(snapshot);
      return true;
    },
  };
}

/** Adopt supported Markdown as editor structure. Unsupported syntax stays source
 * text, and only held placeholders can acquire recipient provenance. */
function rewriteDocument(text: string): Node | undefined {
  const schema = composerSchema;
  const tree = fromMarkdown(text, {
    extensions: [gfmStrikethrough({ singleTilde: false })],
    mdastExtensions: [gfmStrikethroughFromMarkdown()],
  });
  const sourceOnly = new WeakSet<Node>();
  const literal = (node: Nodes, marks: readonly Mark[]) => {
    const value = text.slice(
      node.position?.start.offset,
      node.position?.end.offset,
    );
    if (!value) return [];
    const content = schema.text(value, marks);
    sourceOnly.add(content);
    return [content];
  };
  const sourceBlock = (node: Nodes, marks: readonly Mark[]) => {
    const paragraph = schema.nodes.paragraph.create(null, literal(node, marks));
    sourceOnly.add(paragraph);
    return [paragraph];
  };
  const read = (
    node: Nodes,
    marks: readonly Mark[] = [],
    depth = 0,
  ): Node[] => {
    if (depth > 100) throw new RangeError("Rewrite nesting exceeds limit");
    const children = (next = marks) =>
      "children" in node
        ? node.children.flatMap((child) => read(child, next, depth + 1))
        : [];
    // The editor serializes adjacent paragraphs with a single newline. An
    // empty paragraph retains Markdown's blank separator between prose blocks.
    const blocks = (content: Node[]) => {
      const normalized = content.map((node) =>
        node.isInline ? schema.nodes.paragraph.create(null, node) : node,
      );
      return normalized.flatMap((block, index) => {
        return index &&
          normalized[index - 1]?.type === schema.nodes.paragraph &&
          block.type === schema.nodes.paragraph
          ? [schema.nodes.paragraph.create(), block]
          : [block];
      });
    };
    const block = (
      name:
        | "paragraph"
        | "blockquote"
        | "bullet_list"
        | "ordered_list"
        | "list_item",
      attrs = {},
    ) => {
      const content = children();
      // Raw source offsets inside containers include continuation prefixes.
      // Preserve the enclosing container too, so serialization adds none twice.
      if (content.some((child) => sourceOnly.has(child)))
        return sourceBlock(node, marks);
      const blockNode = schema.nodes[name].createAndFill(
        attrs,
        name === "paragraph" ? content : blocks(content),
      );
      if (!blockNode) throw new RangeError("Invalid rewrite block");
      return [blockNode];
    };
    const marked = (name: "bold" | "italic" | "strike" | "link", attrs = {}) =>
      children(schema.marks[name].create(attrs).addToSet(marks));
    switch (node.type) {
      case "root":
        return blocks(children());
      case "paragraph":
        return block("paragraph");
      case "blockquote":
        return block("blockquote");
      case "list":
        // The schema requires a paragraph first in each item. Adding one before
        // a quote or nested list changes Markdown meaning, so keep that source.
        if (
          node.children.some(
            (item) => item.children[0] && item.children[0].type !== "paragraph",
          )
        )
          return sourceBlock(node, marks);
        return block(node.ordered ? "ordered_list" : "bullet_list", {
          order: node.start ?? 1,
        });
      case "listItem":
        return block("list_item");
      case "strong":
        return marked("bold");
      case "emphasis":
        return marked("italic");
      case "delete":
        return marked("strike");
      case "text":
        return node.value
          ? [
              schema.text(
                node.value,
                text.slice(
                  node.position?.start.offset,
                  node.position?.end.offset,
                ) === node.value
                  ? marks
                  : [...marks, schema.marks.literal.create()],
              ),
            ]
          : [];
      case "break":
        return [schema.nodes.hard_break.create(null, null, marks)];
      case "inlineCode":
        return node.value
          ? [schema.text(node.value, [schema.marks.code.create()])]
          : [];
      case "code":
        if (node.meta) return sourceBlock(node, marks);
        return [
          schema.nodes.code_block.create(
            { language: node.lang ?? null },
            node.value ? schema.text(node.value) : undefined,
          ),
        ];
      case "link": {
        const href = composerLinkUrl(node.url);
        return href && !node.title
          ? marked("link", { href })
          : literal(node, marks);
      }
      default: {
        const content = literal(node, marks);
        return ["heading", "thematicBreak", "definition"].includes(node.type)
          ? sourceBlock(node, marks)
          : content;
      }
    }
  };
  try {
    const content = read(tree);
    const doc = schema.nodes.doc.create(
      null,
      content.length ? content : schema.nodes.paragraph.create(),
    );
    doc.check();
    return doc;
  } catch {
    return;
  }
}
