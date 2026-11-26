/** Find on screen reports at most this many matches, bounding work per pass. */
export const FIND_LIMIT = 1000;

const SKIPPED =
  'script, style, noscript, template, textarea, select, .sr-only, [inert], [contenteditable]:not([contenteditable="false"])';

/**
 * Whether text in `element` is on-screen text a person can select. Labels,
 * fields, the excluded subtree and content the engine reports as not visible
 * (`display: none`, `visibility: hidden`, covered `content-visibility: hidden`
 * tabs) don't count. Neither does `user-select: none` chrome such as sidebar
 * rows: WebKit paints highlights there onto the next selectable text instead.
 * Inert content, such as a collapsed drop target, can't be selected either,
 * even where its computed style says it can. A highlight there makes older
 * WebKit paint the unselectable text around it.
 */
function findable(element: Element, exclude: Element | null | undefined) {
  if (element.closest(SKIPPED) || exclude?.contains(element)) return false;
  if (!(element.checkVisibility?.({ visibilityProperty: true }) ?? true))
    return false;
  const style = getComputedStyle(element);
  return style.userSelect !== "none" && style.webkitUserSelect !== "none";
}

/**
 * `value` lowercased. Lowercasing can lengthen a character (`İ` becomes `i̇`);
 * then each lowercased code unit also maps to its character's source bounds.
 */
function lower(value: string) {
  const text = value.toLowerCase();
  if (text.length === value.length) return { text };
  let folded = "";
  const starts: number[] = [];
  const ends: number[] = [];
  let start = 0;
  for (const char of value) {
    const end = start + char.length;
    const lowered = char.toLowerCase();
    folded += lowered;
    for (let unit = 0; unit < lowered.length; unit++) {
      starts.push(start);
      ends.push(end);
    }
    start = end;
  }
  return { text: folded, starts, ends };
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
    const { text, starts, ends } = lower(node.nodeValue ?? "");
    let at = text.indexOf(needle);
    // Style checks are the cost; only text that matches pays it.
    const parent = node.parentElement;
    if (at === -1 || !parent) continue;
    const ok = checked.get(parent) ?? findable(parent, exclude);
    checked.set(parent, ok);
    if (!ok) continue;
    for (; at !== -1; at = text.indexOf(needle, at + needle.length)) {
      const range = document.createRange();
      const last = at + needle.length - 1;
      range.setStart(node, starts?.[at] ?? at);
      range.setEnd(node, ends?.[last] ?? last + 1);
      ranges.push(range);
      if (ranges.length === FIND_LIMIT) return ranges;
    }
  }
  return ranges;
}

/** Transcript matches can cross inline formatting, but never block boundaries.
 * Collapsed bodies count too; navigation opens their native disclosures. */
export function findTranscriptRanges(
  root: HTMLElement,
  query: string,
): Range[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const document = root.ownerDocument;
  const ranges: Range[] = [];
  const styles = new Map<Element, CSSStyleDeclaration>();
  const styleOf = (element: Element) => {
    let style = styles.get(element);
    if (!style) {
      style = getComputedStyle(element);
      styles.set(element, style);
    }
    return style;
  };
  const selectable = (element: Element) => {
    if (element.closest(`${SKIPPED}, button, [data-transcript-preview]`))
      return false;
    for (let node: Element | null = element; node; node = node.parentElement) {
      const style = styleOf(node);
      if (
        style.display === "none" ||
        style.visibility === "hidden" ||
        style.contentVisibility === "hidden" ||
        style.userSelect === "none" ||
        style.webkitUserSelect === "none"
      )
        return false;
      if (node === root) break;
    }
    return true;
  };
  let block: Element | null = null;
  let text = "";
  let chunks: { node: Node; start: number; end: number }[] = [];
  const flush = () => {
    const folded = lower(text);
    for (
      let at = folded.text.indexOf(needle);
      at !== -1 && ranges.length < FIND_LIMIT;
      at = folded.text.indexOf(needle, at + needle.length)
    ) {
      const start = folded.starts?.[at] ?? at;
      const last = at + needle.length - 1;
      const end = folded.ends?.[last] ?? last + 1;
      const first = chunks.find((chunk) => chunk.end > start);
      const final = chunks.find((chunk) => chunk.end >= end);
      if (!first || !final) continue;
      const range = document.createRange();
      range.setStart(first.node, start - first.start);
      range.setEnd(final.node, end - final.start);
      ranges.push(range);
    }
    text = "";
    chunks = [];
  };
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const parent = node.parentElement;
    if (!parent || !selectable(parent)) {
      flush();
      block = null;
      continue;
    }
    const current = parent.closest(
      "p, pre, summary, li, td, th, h1, h2, h3, h4, h5, h6, div, section, article",
    );
    if (current !== block) flush();
    if (ranges.length === FIND_LIMIT) break;
    block = current;
    const start = text.length;
    text += node.nodeValue ?? "";
    chunks.push({ node, start, end: text.length });
  }
  if (ranges.length < FIND_LIMIT) flush();
  return ranges;
}
