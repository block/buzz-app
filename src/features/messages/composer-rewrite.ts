import type { EditorState, Transaction } from "prosemirror-state";
import { Selection } from "prosemirror-state";
import type { Node } from "prosemirror-model";
import type { ComposerDraftSnapshot } from "../conversation/contracts";
import type { DraftRecipient, MentionDraft } from "./mention-draft";
import { projectComposerDocument } from "./composer-document";
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
        tr.insertText(
          marker.marker,
          source.position(person.start),
          source.position(person.end, -1),
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
      let cursor = 0;
      let output = "";
      const recipients: DraftRecipient[] = [];
      for (const person of positions) {
        output += text.slice(cursor, person.at);
        const start = output.length;
        output += `@${person.name}`;
        recipients.push({
          pubkey: person.pubkey,
          name: person.name,
          start,
          end: output.length,
        });
        cursor = person.at + person.marker.length;
      }
      output += text.slice(cursor);
      if (output.includes("BUZZMENTION")) return false;
      const doc = host.document({ text: output, recipients });
      if (
        composerMarkdown(projectComposerDocument(doc).draft).length >
        host.maxLength()
      )
        return false;
      // Revalidate provenance after parsing. A rewrite cannot drop or invent intent.
      const actual = projectComposerDocument(doc).draft.recipients;
      if (
        actual.length !== recipients.length ||
        actual.some(
          (person, index) => person.pubkey !== recipients[index]?.pubkey,
        )
      )
        return false;
      const tr = host
        .state()
        .tr.replaceWith(0, host.state().doc.content.size, doc.content);
      tr.setSelection(Selection.atEnd(tr.doc));
      if (!host.apply(tr)) return false;
      held.delete(snapshot);
      return true;
    },
  };
}
