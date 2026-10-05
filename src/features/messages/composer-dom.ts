import type { EditorState } from "prosemirror-state";
import type { PlainLink } from "./composer-link-edit";
import type { MentionDraft, MentionRecipient } from "./mention-draft";
import type { ComposerResource } from "../conversation/contracts";

export const inlineFormats = [
  {
    mark: "bold",
    label: "Bold",
    inputType: "formatBold",
    binding: { key: "b", mod: true, shift: false },
  },
  {
    mark: "italic",
    label: "Italic",
    inputType: "formatItalic",
    binding: { key: "i", mod: true, shift: false },
  },
  {
    mark: "strike",
    label: "Strikethrough",
    inputType: "formatStrikeThrough",
    binding: { key: "x", mod: true, shift: true },
  },
  {
    mark: "spoiler",
    label: "Spoiler",
    inputType: "formatSpoiler",
    binding: { key: "p", mod: true, shift: true },
  },
  {
    mark: "code",
    label: "Code",
    inputType: "formatInlineCode",
    binding: { key: "e", mod: true, shift: false },
  },
] as const;
export type InlineFormat = (typeof inlineFormats)[number]["mark"];
export const blockFormats = [
  {
    mark: "code_block",
    label: "Code block",
    binding: { key: "c", mod: true, alt: true, shift: false },
  },
  {
    mark: "bullet_list",
    label: "Bullet list",
    binding: { key: "8", mod: true, shift: true },
  },
  {
    mark: "ordered_list",
    label: "Ordered list",
    binding: { key: "7", mod: true, shift: true },
  },
  {
    mark: "blockquote",
    label: "Quote",
    binding: { key: "b", mod: true, shift: true },
  },
] as const;
export type BlockFormat = (typeof blockFormats)[number]["mark"];
export type ComposerFormat = InlineFormat | BlockFormat;
export const composerFormats = [...inlineFormats, ...blockFormats];

export type ComposerLinkEdit = {
  text: string;
  href: string;
  existing: boolean;
  save(text: string, href: string): boolean;
  remove(): boolean;
};

/** Host-retained editor state; no view, DOM or contribution demand survives detach. */
export type ComposerCheckpoint = {
  state: EditorState;
  draft: MentionDraft;
  plain: PlainLink[];
  separateHistory: boolean;
};

/** Public commands remain in authored-source offsets. Only the editor adapter
 * translates them into document positions; callers never manipulate its DOM. */
export type ComposerInputElement = HTMLDivElement & {
  value: string;
  selectionStart: number;
  selectionEnd: number;
  selectionDirection: "forward" | "backward" | "none";
  disabled: boolean;
  readOnly: boolean;
  setSelectionRange(start: number, end: number, direction?: string): void;
  insertText(
    text: string,
    recipient?: MentionRecipient,
    range?: { start: number; end: number },
  ): boolean;
  /** Host-owned inline link atom at the caret; a string is the rejection reason. */
  insertResource(resource: ComposerResource): true | string;
  captureCheckpoint(): ComposerCheckpoint;
  restoreCheckpoint(saved: ComposerCheckpoint): void;
  toggleFormat(format: ComposerFormat): void;
  insertLineBreak(): boolean;
  editLink(): ComposerLinkEdit | null;
  removeRecipient(pubkey: string): void;
  undo(redo: boolean): void;
  reset(draft: MentionDraft): void;
  /** Retain this editor's document, selection and undo state across a temporary edit. */
  checkpoint(): () => void;
};

export function editorText(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
  if (node instanceof HTMLElement) {
    if (node.dataset.source !== undefined) return node.dataset.source;
    if (node.tagName === "BR") return node.dataset.placeholder ? "" : "\n";
  }
  let text = "";
  for (const child of node.childNodes) {
    if (
      child instanceof HTMLElement &&
      /^(DIV|P)$/.test(child.tagName) &&
      text &&
      !text.endsWith("\n")
    )
      text += "\n";
    text += editorText(child);
  }
  if (
    node instanceof HTMLElement &&
    node.hasAttribute("data-editor-text") &&
    text.startsWith("\u200B")
  )
    return text.slice(1);
  return text;
}

export function sourceOffset(root: HTMLElement, node: Node, offset: number) {
  const range = root.ownerDocument.createRange();
  range.selectNodeContents(root);
  // WebKit can briefly retain the old offset when an input/portal commit replaces
  // the selected text node. Normalize that transient position before making a Range.
  const limit =
    node.nodeType === Node.TEXT_NODE
      ? (node.textContent?.length ?? 0)
      : node.childNodes.length;
  range.setEnd(node, Math.max(0, Math.min(offset, limit)));
  return editorText(range.cloneContents()).length;
}

export function editorSelection(root: HTMLElement) {
  const selection = root.ownerDocument.getSelection();
  if (
    !selection?.anchorNode ||
    !selection.focusNode ||
    !root.contains(selection.anchorNode) ||
    !root.contains(selection.focusNode)
  )
    return undefined;
  const anchor = sourceOffset(
    root,
    selection.anchorNode,
    selection.anchorOffset,
  );
  const focus = sourceOffset(root, selection.focusNode, selection.focusOffset);
  return {
    start: Math.min(anchor, focus),
    end: Math.max(anchor, focus),
    backward: anchor > focus,
  };
}

/** Noneditable inline content does not reliably receive the browser's selection paint. */
export function highlightEditorSelection(root: HTMLElement) {
  const selection = editorSelection(root);
  let offset = 0;
  for (const node of root.childNodes) {
    const length = editorText(node).length;
    if (node instanceof HTMLElement && node.dataset.source !== undefined)
      node.toggleAttribute(
        "data-editor-selected",
        !!selection &&
          selection.start < selection.end &&
          selection.start <= offset &&
          selection.end >= offset + length,
      );
    offset += length;
  }
}

/** Native paste/selection restoration can leave a caret inside a noneditable
 * label. Its source offset is valid, but the browser refuses subsequent typing. */
export function normalizeTokenCaret(root: ComposerInputElement) {
  const selection = root.ownerDocument.getSelection();
  if (
    !selection?.isCollapsed ||
    root.ownerDocument.activeElement !== root ||
    root.disabled ||
    root.readOnly
  )
    return;
  const node = selection.anchorNode;
  const token = (
    node instanceof Element ? node : node?.parentElement
  )?.closest<HTMLElement>("[data-source]");
  if (!token?.parentNode || !root.contains(token)) return;
  const index = [...token.parentNode.childNodes].indexOf(token);
  const end =
    sourceOffset(root, token.parentNode, index) + editorText(token).length;
  root.setSelectionRange(end, end);
}

export function setEditorSelection(
  root: HTMLElement,
  start: number,
  end: number,
  backward = false,
) {
  // A programmatic selection into a token opens its exact source for editing.
  let offset = 0;
  for (const node of [...root.childNodes]) {
    const length = editorText(node).length;
    if (
      node instanceof HTMLElement &&
      node.dataset.source !== undefined &&
      ((start > offset && start < offset + length) ||
        (end > offset && end < offset + length))
    )
      node.replaceWith(root.ownerDocument.createTextNode(node.dataset.source));
    offset += length;
  }
  const point = (position: number): [Node, number] => {
    let offset = 0;
    for (let index = 0; index < root.childNodes.length; index++) {
      const node = root.childNodes[index];
      if (!node) continue;
      const length = editorText(node).length;
      if (position <= offset + length) {
        if (node.nodeType === Node.TEXT_NODE)
          return [node, Math.max(0, position - offset)];
        if (
          node instanceof HTMLElement &&
          node.hasAttribute("data-editor-text") &&
          node.firstChild
        ) {
          // Pasting can split this editable span before React rebuilds it.
          node.normalize();
          return [
            node.firstChild,
            Math.max(0, position - offset) +
              (node.textContent?.startsWith("\u200B") ? 1 : 0),
          ];
        }
        // Keep the caret in editable text after the rendered item, not in the
        // parent element at a boundary that browsers can paint before the item.
        if (
          position === offset + length &&
          node.nextSibling?.nodeType === Node.TEXT_NODE
        )
          return [node.nextSibling, 0];
        if (
          position === offset + length &&
          node.nextSibling instanceof HTMLElement &&
          node.nextSibling.hasAttribute("data-editor-text") &&
          node.nextSibling.firstChild
        )
          return [
            node.nextSibling.firstChild,
            node.nextSibling.textContent?.startsWith("\u200B") ? 1 : 0,
          ];
        return [root, position <= offset ? index : index + 1];
      }
      offset += length;
    }
    return [root, root.childNodes.length];
  };
  const first = point(start),
    last = point(end);
  root.ownerDocument
    .getSelection()
    ?.setBaseAndExtent(
      ...(backward ? last : first),
      ...(backward ? first : last),
    );
  highlightEditorSelection(root);
}

/** Open a link's source before the browser performs ordinary text navigation or deletion. */
export function editAdjacentLink(
  root: ComposerInputElement,
  backward: boolean,
  arrow: boolean,
  extend: boolean,
) {
  if (root.selectionStart !== root.selectionEnd) return;
  const caret = root.selectionStart;
  let offset = 0;
  for (const node of [...root.childNodes]) {
    const length = editorText(node).length;
    if (
      node instanceof HTMLElement &&
      node.dataset.source !== undefined &&
      caret === (backward ? offset + length : offset)
    ) {
      if (!node.hasAttribute("data-edit-as-text")) {
        if (arrow && !extend) {
          const next = backward ? offset : offset + length;
          root.setSelectionRange(next, next);
        } else
          root.setSelectionRange(
            offset,
            offset + length,
            backward ? "backward" : "forward",
          );
        return arrow;
      }
      const text = root.ownerDocument.createTextNode(node.dataset.source ?? "");
      node.replaceWith(text);
      const position = backward ? text.length : 0;
      root.ownerDocument
        .getSelection()
        ?.setBaseAndExtent(text, position, text, position);
      return false;
    }
    offset += length;
  }
}
