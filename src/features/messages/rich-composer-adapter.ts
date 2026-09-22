import { Editor } from "@tiptap/core";
import { closeHistory } from "@tiptap/pm/history";
import { EditorState, Plugin } from "@tiptap/pm/state";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import HardBreak from "@tiptap/extension-hard-break";
import Link from "@tiptap/extension-link";
import StarterKit from "@tiptap/starter-kit";
import { Markdown as TiptapMarkdown } from "tiptap-markdown";
import type { ComposerObservation } from "../conversation/contracts";
import { mentionDraft, type MentionDraft } from "./mention-draft";
import {
  CUSTOM_EMOJI_NODE,
  CustomEmojiNode,
} from "./rich-composer/customEmojiNode";
import type { CustomEmoji } from "../relay/emoji";
import { RECIPIENT_NODE, RecipientNode } from "./rich-composer/recipientNode";

const recipientMarker = (token: string) => `\uE000recipient:${token}\uE001`;
const leafText = (node: {
  type: { name: string };
  attrs: Record<string, unknown>;
}) =>
  node.type.name === RECIPIENT_NODE
    ? `@${String(node.attrs.name ?? "")}`
    : node.type.name === CUSTOM_EMOJI_NODE
      ? String(node.attrs.source)
      : node.type.name === "hardBreak"
        ? "\n"
        : "";

export type RichComposerSnapshot = Readonly<{
  revision: number;
  editingText: string;
  selectionStart: number;
  selectionEnd: number;
  draft: MentionDraft;
  editable: boolean;
}>;

/** Host-local bridge between the rich document and existing plain-text contracts. */
export class RichComposerAdapter {
  readonly editor: Editor;
  #revision = 0;
  #nextToken = 0;
  #emoji = new Map<string, string>();
  #restoring = false;
  #rejected = false;
  #listeners = new Set<(documentChanged: boolean) => void>();

  constructor(
    element: HTMLElement,
    draft: MentionDraft = mentionDraft(""),
    private readonly onRejected: (reason: string) => void = () => {},
  ) {
    this.editor = new Editor({
      element,
      extensions: [
        RecipientNode,
        CustomEmojiNode,
        StarterKit.configure({ heading: false, link: false, hardBreak: false }),
        HardBreak.extend({
          addStorage() {
            return {
              markdown: {
                // The default serializer drops breaks at the end of a paragraph.
                // In a message these are authored content, not layout padding.
                serialize(state: { write(text: string): void }) {
                  state.write("\\\n");
                },
              },
            };
          },
        }),
        Link.configure({ openOnClick: false }),
        TiptapMarkdown.configure({ html: false, breaks: true }),
      ],
      content: "",
      onTransaction: ({ transaction }) => {
        ++this.#revision;
        for (const listener of this.#listeners)
          listener(transaction.docChanged);
      },
    });
    this.restore(draft);
    this.editor.registerPlugin(
      new Plugin({
        appendTransaction: (transactions, _old, state) => {
          if (
            !transactions.some(
              (transaction) =>
                transaction.docChanged || transaction.getMeta("emojiCatalog"),
            )
          )
            return null;
          return this.#decorateEmoji(state);
        },
        filterTransaction: (transaction) => {
          if (
            !transaction.docChanged ||
            this.#restoring ||
            transaction.getMeta("emojiDecoration")
          )
            return true;
          let count = 0;
          transaction.doc.descendants((node) => {
            if (node.type.name === RECIPIENT_NODE) ++count;
          });
          const reason = !this.editor.isEditable
            ? "This draft is not editable"
            : count > 32
              ? "Choose at most 32 recipients"
              : this.#serialize(transaction.doc).text.length > 16000
                ? "Message is too long"
                : undefined;
          if (!reason) return true;
          this.#rejected = true;
          this.onRejected(reason);
          return false;
        },
      }),
    );
  }

  destroy() {
    this.#listeners.clear();
    this.editor.destroy();
  }

  subscribe(listener: (documentChanged: boolean) => void) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  setEditable(editable: boolean) {
    this.editor.setEditable(editable);
  }

  snapshot(): RichComposerSnapshot {
    const { from, to } = this.editor.state.selection;
    const editingText = this.#editingText();
    return Object.freeze({
      revision: this.#revision,
      editingText,
      selectionStart: this.#editingOffset(from),
      selectionEnd: this.#editingOffset(to),
      draft: this.#serialize(),
      editable: this.editor.isEditable,
    });
  }

  observation(): ComposerObservation | undefined {
    const value = this.snapshot();
    if (!value.editable || value.selectionStart !== value.selectionEnd)
      return undefined;
    return Object.freeze({
      revision: value.revision,
      text: value.editingText,
      start: value.selectionStart,
      end: value.selectionEnd,
    });
  }

  setEditingSelection(start: number, end = start) {
    const from = this.#documentPosition(start);
    const to = this.#documentPosition(end);
    if (from === undefined || to === undefined || from > to) return false;
    return this.editor.commands.setTextSelection({ from, to });
  }

  replaceEditingRange(
    observation: ComposerObservation,
    start: number,
    end: number,
    text: string,
  ) {
    const current = this.observation();
    if (
      !current ||
      current.revision !== observation.revision ||
      current.text !== observation.text ||
      current.start !== observation.start ||
      current.end !== observation.end
    )
      return false;
    const from = this.#documentPosition(start);
    const to = this.#documentPosition(end);
    if (from === undefined || to === undefined || from > to) return false;
    this.editor.view.focus();
    this.#rejected = false;
    this.editor.view.dispatch(this.editor.state.tr.insertText(text, from, to));
    if (this.#rejected) return false;
    this.editor.view.dispatch(closeHistory(this.editor.state.tr));
    return true;
  }

  insertMention(pubkey: string, name: string) {
    if (
      !this.editor.isEditable ||
      !/^[0-9a-f]{64}$/.test(pubkey) ||
      !name.trim()
    )
      return false;
    this.#rejected = false;
    const marks = (
      this.editor.state.storedMarks ?? this.editor.state.selection.$from.marks()
    ).map((mark) => mark.toJSON());
    const accepted = this.editor
      .chain()
      .focus()
      .insertContent([
        {
          type: RECIPIENT_NODE,
          attrs: { pubkey, name, token: this.#token() },
          marks,
        },
        { type: "text", text: " ", marks },
      ])
      .run();
    if (!accepted || this.#rejected) return false;
    this.editor.view.dispatch(closeHistory(this.editor.state.tr));
    return true;
  }

  setEmoji(
    entries: readonly CustomEmoji[],
    media: (url: string) => string | undefined,
  ) {
    this.#emoji = new Map(
      entries.flatMap((entry) => {
        const url = media(entry.url);
        return url ? [[entry.shortcode.toLowerCase(), url] as const] : [];
      }),
    );
    this.editor.view.dispatch(
      this.editor.state.tr
        .setMeta("emojiCatalog", true)
        .setMeta("addToHistory", false),
    );
  }

  #decorateEmoji(state: EditorState) {
    const replacements: {
      from: number;
      to: number;
      source: string;
      url?: string | undefined;
    }[] = [];
    state.doc.descendants((node, position) => {
      if (node.type.name === "codeBlock") return false;
      if (node.type.name === CUSTOM_EMOJI_NODE) {
        const source = String(node.attrs.source);
        const url = this.#emoji.get(source.slice(1, -1).toLowerCase());
        if (url !== node.attrs.url)
          replacements.push({
            from: position,
            to: position + node.nodeSize,
            source,
            url,
          });
      } else if (
        node.isText &&
        !node.marks.some((mark) => mark.type.name === "code")
      ) {
        for (const match of (node.text ?? "").matchAll(
          /:([a-z0-9_-]{1,64}):/gi,
        )) {
          const url = this.#emoji.get((match[1] ?? "").toLowerCase());
          if (url)
            replacements.push({
              from: position + match.index,
              to: position + match.index + match[0].length,
              source: match[0],
              url,
            });
        }
      }
    });
    if (!replacements.length) return null;
    const transaction = state.tr.setMeta("emojiDecoration", true);
    for (const { from, to, source, url } of replacements.reverse()) {
      const marks = state.doc.resolve(from).marks();
      transaction.replaceWith(
        from,
        to,
        url
          ? state.schema.node(
              CUSTOM_EMOJI_NODE,
              { source, url },
              undefined,
              marks,
            )
          : this.editor.schema.text(source, marks),
      );
    }
    return transaction;
  }

  removeRecipient(pubkey: string) {
    if (!this.editor.isEditable) return false;
    const matches: { position: number; size: number; name: string }[] = [];
    this.editor.state.doc.descendants((node, position) => {
      if (node.type.name === RECIPIENT_NODE && node.attrs.pubkey === pubkey)
        matches.push({
          position,
          size: node.nodeSize,
          name: String(node.attrs.name),
        });
    });
    if (!matches.length) return false;
    const transaction = this.editor.state.tr;
    for (const match of matches.reverse()) {
      const node = transaction.doc.nodeAt(match.position);
      transaction.replaceWith(
        match.position,
        match.position + match.size,
        this.editor.schema.text(`@${match.name}`, node?.marks),
      );
    }
    this.editor.view.dispatch(transaction);
    return true;
  }

  restore(value: MentionDraft) {
    this.#restoring = true;
    try {
      this.#restore(value);
    } finally {
      this.#restoring = false;
    }
  }

  #restore(value: MentionDraft) {
    const draft = mentionDraft(value);
    const orderedRecipients = [...draft.recipients].sort(
      (a, b) => b.start - a.start,
    );
    let recipients: {
      recipient: MentionDraft["recipients"][number];
      token: string;
    }[] = [];
    const trailingWhitespace = draft.text.match(/[ \t]+$/)?.[0] ?? "";
    let represented = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      recipients = orderedRecipients.map((recipient) => ({
        recipient,
        token: this.#token(),
      }));
      let markdown = draft.text;
      for (const { recipient, token } of recipients)
        markdown =
          markdown.slice(0, recipient.start) +
          recipientMarker(token) +
          markdown.slice(recipient.end);
      this.editor.commands.setContent(markdown, { emitUpdate: false });
      const parsedText = this.#editingText();
      const occurrences = recipients.map(({ token }) => {
        const marker = recipientMarker(token);
        const first = parsedText.indexOf(marker);
        return first < 0 ? 0 : first === parsedText.lastIndexOf(marker) ? 1 : 2;
      });
      if (occurrences.includes(0)) break;
      if (occurrences.every((count) => count === 1)) {
        represented = true;
        break;
      }
    }
    if (!represented) {
      recipients = [];
      this.editor.commands.setContent(draft.text, { emitUpdate: false });
    }
    if (
      trailingWhitespace &&
      !this.#editingText().endsWith(trailingWhitespace)
    ) {
      const end = Math.max(1, this.editor.state.doc.content.size - 1);
      this.editor.view.dispatch(
        this.editor.state.tr.insertText(trailingWhitespace, end),
      );
    }
    const trailingBreaks = draft.text.match(/\n+$/)?.[0].length ?? 0;
    const representedBreaks =
      this.#editingText().match(/\n+$/)?.[0].length ?? 0;
    if (trailingBreaks > representedBreaks) {
      const end = Math.max(1, this.editor.state.doc.content.size - 1);
      this.editor.view.dispatch(
        this.editor.state.tr.insert(
          end,
          Array.from({ length: trailingBreaks - representedBreaks }, () =>
            this.editor.schema.node("hardBreak"),
          ),
        ),
      );
    }
    for (const { recipient, token } of recipients.reverse()) {
      const marker = recipientMarker(token);
      const text = this.#editingText();
      const start = text.indexOf(marker);
      if (start < 0) continue;
      const from = this.#documentPosition(start);
      const to = this.#documentPosition(start + marker.length);
      if (from === undefined || to === undefined) continue;
      const marks = this.editor.state.doc
        .resolve(from)
        .marks()
        .map((mark) => mark.toJSON());
      this.editor
        .chain()
        .setTextSelection({ from, to })
        .insertContent({
          type: RECIPIENT_NODE,
          attrs: { ...recipient, token },
          marks,
        })
        .run();
    }
    this.editor.commands.setTextSelection(
      Math.max(1, this.editor.state.doc.content.size - 1),
    );
    const { state } = this.editor;
    this.editor.view.updateState(
      EditorState.create({
        schema: state.schema,
        doc: state.doc,
        selection: state.selection,
        plugins: state.plugins,
      }),
    );
  }

  #token() {
    return `${++this.#nextToken}`;
  }

  #editingText() {
    return this.editor.state.doc.textBetween(
      0,
      this.editor.state.doc.content.size,
      "\n",
      leafText,
    );
  }

  #editingOffset(position: number) {
    return this.editor.state.doc.textBetween(0, position, "\n", leafText)
      .length;
  }

  #documentPosition(offset: number) {
    if (!Number.isInteger(offset) || offset < 0) return undefined;
    const doc = this.editor.state.doc;
    for (let candidate = 0; candidate <= doc.content.size; candidate++) {
      if (!doc.resolve(candidate).parent.inlineContent) continue;
      if (doc.textBetween(0, candidate, "\n", leafText).length === offset)
        return candidate;
    }
    return undefined;
  }

  #serialize(doc: ProseMirrorNode = this.editor.state.doc): MentionDraft {
    const storage = this.editor.storage as unknown as {
      markdown?: { serializer?: { serialize(content: unknown): string } };
    };
    const authoredText = doc.textBetween(0, doc.content.size, "\n", (node) =>
      node.type.name === RECIPIENT_NODE ? "" : leafText(node),
    );
    const nodes: {
      position: number;
      marker: string;
      pubkey: string;
      name: string;
    }[] = [];
    doc.descendants((node, position) => {
      if (node.type.name !== RECIPIENT_NODE) return;
      let token: string;
      let marker: string;
      do {
        token = this.#token();
        marker = recipientMarker(token);
      } while (authoredText.includes(marker));
      nodes.push({
        position,
        marker,
        pubkey: String(node.attrs.pubkey ?? ""),
        name: String(node.attrs.name ?? ""),
      });
    });
    let serializationTransaction = EditorState.create({
      schema: this.editor.schema,
      doc,
    }).tr;
    for (const node of nodes)
      serializationTransaction = serializationTransaction.setNodeMarkup(
        node.position,
        undefined,
        {
          ...serializationTransaction.doc.nodeAt(node.position)?.attrs,
          token: node.marker.slice("\uE000recipient:".length, -1),
        },
      );
    const serializedDoc = serializationTransaction.doc;
    let serialized =
      storage.markdown?.serializer?.serialize(serializedDoc.content) ??
      this.#editingText();
    serialized = serialized.replace(/\\\n/g, "\n");

    const occurrences = nodes
      .map((node) => ({ ...node, start: serialized.indexOf(node.marker) }))
      .filter((node) => node.start >= 0)
      .sort((a, b) => a.start - b.start);
    let cursor = 0;
    let text = "";
    const recipients = [];
    for (const node of occurrences) {
      text += serialized.slice(cursor, node.start);
      const start = text.length;
      const display = `@${node.name}`;
      text += display;
      recipients.push({
        pubkey: node.pubkey,
        name: node.name,
        start,
        end: start + display.length,
      });
      cursor = node.start + node.marker.length;
    }
    text += serialized.slice(cursor);
    return mentionDraft({ text, recipients });
  }
}
