import { serializeSelection } from "../../features/messages/selection-copy";

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
  const fragments = Array.from({ length: selection.rangeCount }, (_, index) =>
    selection.getRangeAt(index).cloneContents(),
  );
  if (
    !fragments.some((fragment) =>
      fragment.querySelector("img[data-copy-emoji]"),
    )
  )
    return;
  event.clipboardData.setData(
    "text/plain",
    serializeSelection(selection, "text"),
  );
  event.preventDefault();
}
