import { messageListOf } from "./message-selection";
import { messageCopyLink } from "./message-copy";
import {
  messageSelection,
  selectedMessages,
  serializeSelection,
  timelineCopy,
} from "./selection-copy";

/** Message text selected within one list whose own composer can quote it. */
export function quotableSelection(selection = document.getSelection()) {
  if (!selection || selection.isCollapsed || !selection.rangeCount) return;
  const ranges = Array.from({ length: selection.rangeCount }, (_, index) =>
    selection.getRangeAt(index),
  );
  if (!ranges.every(messageSelection) || !selection.toString().trim()) return;
  const [owner, ...others] = ranges.map((range) =>
    messageListOf(range.commonAncestorContainer),
  );
  if (
    !owner ||
    others.some((other) => other?.element !== owner.element) ||
    !owner.list.canQuote()
  )
    return;
  return { element: owner.element, list: owner.list, ranges };
}

/** Keep the content and owner before a context menu takes selection/focus. */
export function captureSelectedQuote() {
  const selection = document.getSelection();
  const target = quotableSelection(selection);
  if (!selection || !target) return;
  const rows = selectedMessages(target.ranges);
  const sourceLinks = new Set<string>();
  for (const row of rows) {
    const link = messageCopyLink(row, target.list.scope);
    if (link) sourceLinks.add(link);
  }
  const authors = [...new Set(rows.map((row) => row.authorId))];
  return {
    ...target,
    ranges: target.ranges.map((range) => range.cloneRange()),
    html: timelineCopy(selection, authors),
    text: serializeSelection(selection, "text"),
    sourceLinks: [...sourceLinks],
    messageIds: new Set(rows.map((row) => row.id)),
    authors,
  };
}

/** Quote the current selection, or the selection captured by its menu. */
export function quoteSelection(quote = captureSelectedQuote()) {
  const selection = document.getSelection();
  if (
    !selection ||
    !quote?.element.isConnected ||
    messageListOf(quote.element)?.list !== quote.list ||
    !quote.list.canQuote()
  )
    return false;
  // Clear the timeline range before the composer focuses and places its caret;
  // clearing afterwards would remove the composer's caret instead.
  selection.removeAllRanges();
  if (quote.list.quote(quote.html, quote.sourceLinks, quote.authors))
    return true;
  for (const range of quote.ranges)
    if (quote.element.contains(range.commonAncestorContainer))
      selection.addRange(range);
  return false;
}
