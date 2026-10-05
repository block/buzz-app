import { Fragment } from "prosemirror-model";
import { closeHistory } from "prosemirror-history";
import {
  Selection,
  type EditorState,
  type Transaction,
} from "prosemirror-state";
import type { ComposerResource } from "../conversation/contracts";
import {
  composerSchema,
  composerResource,
  projectComposerDocument,
  brokenResources,
} from "./composer-document";
import { composerMarkdown } from "./composer-markdown";

/** Shared validation, without changing the resource picker's caret semantics. */
export function resourceTransactionError(tr: Transaction, maxLength: number) {
  const next = projectComposerDocument(tr.doc);
  if (next.tokens.filter((token) => token.node.attrs.resource).length > 32)
    return "Add at most 32 links to one message";
  if (composerMarkdown(next.draft).length > maxLength)
    return "Message is too long to add this link";
  if (brokenResources(tr.doc, next).length)
    return "Links can't be added inside code or other Markdown here";
  return undefined;
}

/** Share appends at document end, never replacing the selection or inheriting
 * code/link marks. Non-paragraph tails receive a fresh paragraph. */
export function appendComposerResource(
  state: EditorState,
  value: ComposerResource,
  maxLength: number,
): Transaction | string {
  const resource = composerResource(value);
  if (!resource) return "This link can't be added";
  const content = Fragment.fromArray([
    composerSchema.nodes.token.create({
      source: resource.source,
      resource: resource.resource,
    }),
    composerSchema.text(" "),
  ]);
  const last = state.doc.lastChild;
  const tr = closeHistory(state.tr);
  if (
    last?.type === composerSchema.nodes.paragraph &&
    !last.textContent.includes("\n")
  ) {
    const text = projectComposerDocument(state.doc).draft.text;
    const gap = last.content.size && !/\s$/.test(text);
    tr.insert(
      state.doc.content.size - 1,
      gap ? Fragment.from(composerSchema.text(" ")).append(content) : content,
    );
  } else
    tr.insert(
      state.doc.content.size,
      composerSchema.nodes.paragraph.create(null, content),
    );
  tr.setSelection(Selection.atEnd(tr.doc)).setStoredMarks([]);
  // The complete resource is already validated, including while its view is detached.
  tr.setMeta("composer-normalized", true);
  return resourceTransactionError(tr, maxLength) ?? tr;
}
