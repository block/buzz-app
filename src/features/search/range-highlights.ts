/** The highlight registered under `name`, registering it the first time. */
function registered(highlights: HighlightRegistry, name: string) {
  let highlight = highlights.get(name);
  if (!highlight) {
    highlight = new Highlight();
    highlights.set(name, highlight);
  }
  return highlight;
}
/**
 * Older WebKit, including the system web view on macOS, repaints nothing when
 * `CSS.highlights.set()` replaces a registered highlight, so earlier matches
 * stay painted. It also never paints a range object that another highlight
 * already placed. So keep one registered highlight per name, change it in place
 * (which repaints the old ranges and the new), and give it fresh copies.
 */
export function paintHighlights(
  name: string,
  ranges: readonly Range[],
  active: number,
) {
  // Without the Custom Highlight API the bar still counts and scrolls.
  const highlights = globalThis.CSS?.highlights;
  if (!highlights) return;
  const matches = registered(highlights, name);
  const current = registered(highlights, `${name}-active`);
  matches.clear();
  current.clear();
  ranges.forEach((range, index) => {
    // A range whose text was removed has collapsed; there's nothing to paint.
    if (!range.collapsed)
      (index === active ? current : matches).add(range.cloneRange());
  });
}
export function clearHighlights(name: string) {
  globalThis.CSS?.highlights?.delete(name);
  globalThis.CSS?.highlights?.delete(`${name}-active`);
}
/** The distance to move a span so it is centered, when it isn't fully inside. */
const offset = (start: number, end: number, low: number, high: number) =>
  start >= low && end <= high ? 0 : (start + end - low - high) / 2;
/**
 * Scroll each container from the match outward so the match itself is in
 * view. Centering its element instead can leave a match in a long code block
 * offscreen.
 */
export function revealRange(range: Range, covering?: Element | null) {
  const parent = range.startContainer.parentElement;
  // jsdom lays out nothing and has no range geometry.
  if (!range.getBoundingClientRect)
    return parent?.scrollIntoView({ block: "center", inline: "nearest" });
  for (let element = parent; element; element = element.parentElement) {
    const box =
      element === document.scrollingElement
        ? { top: 0, left: 0 }
        : element.getBoundingClientRect();
    const top = Math.max(
      box.top + element.clientTop,
      covering && element.contains(covering)
        ? covering.getBoundingClientRect().bottom
        : Number.NEGATIVE_INFINITY,
    );
    const left = box.left + element.clientLeft;
    const match = range.getBoundingClientRect();
    // Elements that don't scroll ignore these.
    element.scrollTop += offset(
      match.top,
      match.bottom,
      top,
      box.top + element.clientTop + element.clientHeight,
    );
    element.scrollLeft += offset(
      match.left,
      match.right,
      left,
      left + element.clientWidth,
    );
  }
}
