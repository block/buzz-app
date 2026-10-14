import {
  serializeSelection,
  unselectable,
} from "../../features/messages/selection-copy";

/** Preserve event-local shortcodes when copying selected custom emoji images. */
export function copyEmoji(event: ClipboardEvent) {
  // Message surfaces serialize their own selections first (selection-copy.ts).
  if (event.defaultPrevented || !event.clipboardData) return;
  // Editable controls already copy their source text, including shortcodes.
  if (
    event
      .composedPath()
      .some(
        (node) =>
          node instanceof HTMLElement &&
          (node.matches("input, textarea") || node.isContentEditable),
      )
  )
    return;
  const selection = document.getSelection();
  if (!selection || selection.isCollapsed || !selection.rangeCount) return;
  const ranges = Array.from({ length: selection.rangeCount }, (_, index) =>
    selection.getRangeAt(index),
  );
  // Emoji inside excluded chrome leave the engine's own copy in place.
  if (!ranges.some(copiesEmoji)) return;
  event.clipboardData.setData(
    "text/plain",
    serializeSelection(selection, "text"),
  );
  event.preventDefault();
}

// Check the live range: detached clones have no computed `user-select`.
function copiesEmoji(range: Range): boolean {
  const root = range.commonAncestorContainer;
  const scope = root instanceof Element ? root : root.parentElement;
  return [...(scope?.querySelectorAll("img[data-copy-emoji]") ?? [])].some(
    (emoji) => {
      if (!range.intersectsNode(emoji)) return false;
      for (let node: Element | null = emoji; node; node = node.parentElement)
        if (unselectable(node)) return false;
      return true;
    },
  );
}
