/** Find on screen reports at most this many matches, bounding work per pass. */
export const FIND_LIMIT = 1000;

const SKIPPED =
  'script, style, noscript, template, textarea, select, .sr-only, [contenteditable]:not([contenteditable="false"])';

/**
 * Whether text in `element` is on-screen text a person can select. Labels,
 * fields, the excluded subtree and content the engine reports as not visible
 * (`display: none`, `visibility: hidden`, covered `content-visibility: hidden`
 * tabs) don't count. Neither does `user-select: none` chrome such as sidebar
 * rows: WebKit paints highlights there onto the next selectable text instead.
 */
function findable(element: Element, exclude: Element | null | undefined) {
  if (element.closest(SKIPPED) || exclude?.contains(element)) return false;
  if (!(element.checkVisibility?.({ visibilityProperty: true }) ?? true))
    return false;
  const style = getComputedStyle(element);
  return style.userSelect !== "none" && style.webkitUserSelect !== "none";
}

/**
 * Ranges for each case-insensitive occurrence of `query` in the findable text
 * under `root`, in document order. Matches don't span text nodes.
 */
export function findRanges(
  root: Node,
  query: string,
  exclude?: Element | null,
): Range[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const document = root.ownerDocument ?? (root as Document);
  const checked = new Map<Element, boolean>();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const ranges: Range[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const value = node.nodeValue ?? "";
    const text = value.toLowerCase();
    let at = text.indexOf(needle);
    // Style checks are the cost; only text that matches pays it.
    const parent = node.parentElement;
    if (at === -1 || !parent) continue;
    const ok = checked.get(parent) ?? findable(parent, exclude);
    checked.set(parent, ok);
    if (!ok) continue;
    for (; at !== -1; at = text.indexOf(needle, at + needle.length)) {
      const range = document.createRange();
      // Lowercasing can lengthen a few characters (İ); keep offsets in bounds.
      range.setStart(node, Math.min(at, value.length));
      range.setEnd(node, Math.min(at + needle.length, value.length));
      ranges.push(range);
      if (ranges.length === FIND_LIMIT) return ranges;
    }
  }
  return ranges;
}
