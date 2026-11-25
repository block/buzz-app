/*
 * Vim's block cursor over a contenteditable editor: the character after the
 * caret painted with the CSS Custom Highlight API, as an inline decoration
 * would, or a block at the caret where there is no character on the line.
 * The native caret is hidden meanwhile. The editor's DOM is never touched.
 */
import styles from "./BlockCursor.module.css";

const HIGHLIGHT = "vim-block-cursor";
/** Elements that start or end a line. */
const LINE = /^(P|LI|H[1-6]|PRE|BLOCKQUOTE|DIV|UL|OL|TABLE|TR|TD|TH|BR)$/;

/** The next node in document order, within `root`; `into`: its children.
 * "line" where a line ends first. */
function next(node: Node, root: Node, into: boolean): Node | null | "line" {
  if (into && node.firstChild) return node.firstChild;
  for (let at: Node | null = node; at && at !== root; at = at.parentNode) {
    if (at.nextSibling) return at.nextSibling;
    if (at.parentNode instanceof Element && LINE.test(at.parentNode.tagName))
      return "line";
  }
  return null;
}

/** The character right after the caret on its line, if there is one. */
export function characterAfter(root: Node, node: Node, offset: number) {
  const range = document.createRange();
  let at: Node | null | "line";
  if (node instanceof Text) {
    if (offset < node.length) {
      // A line break in the text ends the line.
      if (node.data[offset] === "\n") return undefined;
      const code = node.data.charCodeAt(offset);
      const size = code >= 0xd800 && code < 0xdc00 ? 2 : 1;
      range.setStart(node, offset);
      range.setEnd(node, Math.min(node.length, offset + size));
      return range;
    }
    at = next(node, root, false);
  } else at = node.childNodes[offset] ?? next(node, root, false);
  while (at && at !== "line") {
    if (at instanceof Text && at.length) {
      if (at.data[0] === "\n") return undefined;
      range.setStart(at, 0);
      range.setEnd(at, 1);
      return range;
    }
    if (at instanceof Element) {
      if (LINE.test(at.tagName)) return undefined;
      // A chip is one character.
      if (at.getAttribute("contenteditable") === "false") {
        range.selectNodeContents(at);
        return range;
      }
    }
    at = next(at, root, true);
  }
  return undefined;
}

/** Where the caret is: a collapsed range has no box on an empty line, so
 * the line break after it, or the empty line's own element, gives one. */
function caretRect(node: Node, offset: number) {
  const range = document.createRange();
  range.setStart(node, offset);
  const lined = () =>
    [...range.getClientRects()].find((rect) => rect.height) ??
    (range.getBoundingClientRect().height
      ? range.getBoundingClientRect()
      : undefined);
  let rect = lined();
  if (!rect && node instanceof Text && offset < node.length) {
    range.setEnd(node, offset + 1);
    rect = lined();
  }
  if (rect) return rect;
  const element =
    node instanceof Element
      ? (node.childNodes[offset] ?? node)
      : node.parentElement;
  return element instanceof Element
    ? [...element.getClientRects()].find((box) => box.height)
    : undefined;
}

/** Scroll the box `input` scrolls in so the caret stays `lines` lines from
 * its top and bottom, as Vim's scrolloff. Only a box that overflows moves. */
export function scrollOff(input: HTMLElement, lines = 3) {
  const selection = getSelection();
  const node = selection?.focusNode;
  if (!node || !input.contains(node)) return;
  const caret = caretRect(node, selection.focusOffset);
  const surface = input.closest("[data-composer-surface]");
  let box: HTMLElement | null = input;
  while (
    box &&
    !(
      box.scrollHeight > box.clientHeight &&
      /auto|scroll/.test(getComputedStyle(box).overflowY)
    )
  )
    box = box === surface ? null : box.parentElement;
  if (!caret || !box) return;
  const line =
    Number.parseFloat(getComputedStyle(input).lineHeight) || caret.height;
  // In a box too short for both margins, keep the caret in its middle.
  const margin = Math.min(lines * line, (box.clientHeight - caret.height) / 2);
  const top = box.getBoundingClientRect().top + box.clientTop;
  const above = top + margin - caret.top;
  const below = caret.bottom + margin - (top + box.clientHeight);
  if (above > 0) box.scrollTop -= above;
  else if (below > 0) box.scrollTop += below;
}

/** Show a block cursor in `input` until `stop`; `draw` after it moves. */
export function blockCursor(input: HTMLElement) {
  const block = document.createElement("div");
  block.className = styles.block ?? "";
  block.setAttribute("aria-hidden", "true");
  block.dataset.vimBlockCursor = "";
  block.hidden = true;
  // Longhands: WebKit leaves the computed `font` shorthand empty.
  const style = getComputedStyle(input);
  block.style.fontFamily = style.fontFamily;
  block.style.fontSize = style.fontSize;
  // In a modal dialog's top layer, the block must be in the dialog too.
  (input.closest("dialog, [popover]") ?? document.body).append(block);
  const caret = input.style.caretColor;
  input.style.caretColor = "transparent";

  let frame = 0;
  const draw = () => {
    cancelAnimationFrame(frame);
    frame = 0;
    const selection = getSelection();
    const node = selection?.focusNode;
    block.hidden = true;
    CSS.highlights?.delete(HIGHLIGHT);
    if (!selection?.isCollapsed || !node || !input.contains(node)) return;
    const char = characterAfter(input, node, selection.focusOffset);
    if (char && typeof Highlight === "function") {
      CSS.highlights.set(HIGHLIGHT, new Highlight(char));
      return;
    }
    const rect = caretRect(node, selection.focusOffset);
    if (!rect) return;
    block.style.left = `${rect.left}px`;
    block.style.top = `${rect.top}px`;
    block.style.height = `${rect.height}px`;
    block.hidden = false;
  };
  const later = () => {
    frame ||= requestAnimationFrame(draw);
  };
  const observer = new MutationObserver(later);
  observer.observe(input, {
    childList: true,
    subtree: true,
    characterData: true,
  });
  document.addEventListener("selectionchange", later);
  addEventListener("scroll", later, true);
  addEventListener("resize", later);
  draw();
  return {
    draw,
    stop() {
      cancelAnimationFrame(frame);
      observer.disconnect();
      document.removeEventListener("selectionchange", later);
      removeEventListener("scroll", later, true);
      removeEventListener("resize", later);
      CSS.highlights?.delete(HIGHLIGHT);
      block.remove();
      input.style.caretColor = caret;
    },
  };
}
