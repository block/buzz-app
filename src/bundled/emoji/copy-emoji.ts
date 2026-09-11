/** Preserve event-local shortcodes when copying selected custom emoji images. */
export function copyEmoji(event: ClipboardEvent) {
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
  const values = fragments.map((fragment) => {
    for (const emoji of fragment.querySelectorAll<HTMLImageElement>(
      "img[data-copy-emoji]",
    )) {
      emoji.replaceWith(
        document.createTextNode(emoji.dataset.copyEmoji ?? emoji.alt),
      );
    }
    return selectedText(fragment);
  });
  event.clipboardData.setData("text/plain", values.join("\n"));
  event.preventDefault();
}

// Walk the detached selection only: no hidden DOM insertion, image loads or
// changes to the user's selection. Preserve explicit breaks and block boundaries.
function selectedText(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
  if (node instanceof Element && node.tagName === "BR") return "\n";
  let text = "";
  let previousBlock = false;
  for (const child of node.childNodes) {
    const block =
      child instanceof Element &&
      /^(DIV|P|LI|OL|UL|SECTION|H[1-6])$/.test(child.tagName);
    const value = selectedText(child);
    if (
      text &&
      value &&
      (block || previousBlock) &&
      !text.endsWith("\n") &&
      !value.startsWith("\n")
    )
      text += "\n";
    text += value;
    previousBlock = block;
  }
  return text;
}
