import { Editor } from "@tiptap/core";
import { EditorState } from "@tiptap/pm/state";
import Link from "@tiptap/extension-link";
import StarterKit from "@tiptap/starter-kit";
import { Markdown as TiptapMarkdown } from "tiptap-markdown";
import type { ComposerObservation } from "../conversation/contracts";
import { mentionDraft, type MentionDraft } from "./mention-draft";
import { RECIPIENT_NODE, RecipientNode } from "./rich-composer/recipientNode";

const recipientMarker = (token: string) => `\uE000recipient:${token}\uE001`;
const leafText = (node: {
  type: { name: string };
  attrs: Record<string, unknown>;
}) =>
  node.type.name === RECIPIENT_NODE
    ? `@${String(node.attrs.name ?? "")}`
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
  #listeners = new Set<(documentChanged: boolean) => void>();

  constructor(element: HTMLElement, draft: MentionDraft = mentionDraft("")) {
    this.editor = new Editor({
      element,
      extensions: [
        RecipientNode,
        StarterKit.configure({ heading: false, link: false }),
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
    this.editor.view.dispatch(this.editor.state.tr.insertText(text, from, to));
    return true;
  }

  insertMention(pubkey: string, name: string) {
    if (
      !this.editor.isEditable ||
      !/^[0-9a-f]{64}$/.test(pubkey) ||
      !name.trim()
    )
      return false;
    return this.editor
      .chain()
      .focus()
      .insertContent([
        {
          type: RECIPIENT_NODE,
          attrs: { pubkey, name, token: this.#token() },
        },
        { type: "text", text: " " },
      ])
      .run();
  }

  restore(value: MentionDraft) {
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

  #serialize(): MentionDraft {
    const storage = this.editor.storage as unknown as {
      markdown?: { serializer?: { serialize(content: unknown): string } };
    };
    const authoredText = this.editor.state.doc.textBetween(
      0,
      this.editor.state.doc.content.size,
      "\n",
      (node) => (node.type.name === RECIPIENT_NODE ? "" : leafText(node)),
    );
    const nodes: {
      position: number;
      marker: string;
      pubkey: string;
      name: string;
    }[] = [];
    this.editor.state.doc.descendants((node, position) => {
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
    let serializationTransaction = this.editor.state.tr;
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
