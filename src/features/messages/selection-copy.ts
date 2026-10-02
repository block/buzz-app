import { useEffect } from "react";
import { parseBuzzLink } from "../navigation/buzz-links";
import { profileKey } from "../profiles/target";
import { safeMessageUrl } from "../relay/message-content";

/** `text` reads well outside the app; `markdown` keeps identity locators the
 * composer understands; `html` is the semantic `text/html` flavor. */
export type CopyFormat = "text" | "markdown" | "html";

/** Serialize every range of a live selection; ranges join like lines. */
export function serializeSelection(
  selection: Selection,
  format: CopyFormat,
): string {
  const values: string[] = [];
  for (let index = 0; index < selection.rangeCount; index++) {
    const range = selection.getRangeAt(index);
    if (!range.collapsed)
      values.push(serializeNode(range.commonAncestorContainer, format, range));
  }
  return values.join("\n");
}

/** Walk a DOM tree, clipped to `range` when given. The DOM is untrusted data:
 * identity travels only on validated `nostr:`, `buzz:` and credential-free
 * `https:` destinations, and only when a chip's whole text is selected.
 * Unknown elements degrade to their text. */
export function serializeNode(
  node: Node,
  format: CopyFormat,
  range?: Range,
): string {
  if (range && !range.intersectsNode(node)) return "";
  if (node.nodeType === Node.TEXT_NODE)
    return text(clip(node as Text, range), format);
  if (!(node instanceof Element)) return children(node, format, range);
  // SVG tag names keep their case.
  const tag = node.tagName.toUpperCase();
  if (tag === "BR") return format === "html" ? "<br>" : "\n";
  if (tag === "IMG")
    return text(node.getAttribute("data-copy-emoji") ?? "", format);
  const inner = children(node, format, range);
  const target = node.getAttribute("data-profile-target");
  if (target !== null)
    return whole(node, range) && profileKey(target)
      ? link(
          format,
          target,
          `@${node.getAttribute("data-mention-name") ?? node.textContent}`,
        )
      : inner;
  if (tag === "A")
    return whole(node, range) ? anchor(node, inner, format) : inner;
  switch (tag) {
    case "STRONG":
    case "B":
      return wrap(format, inner, "**", "strong");
    case "EM":
    case "I":
      return wrap(format, inner, "_", "em");
    case "S":
    case "DEL":
      return wrap(format, inner, "~~", "s");
    case "CODE":
      return node.parentElement?.tagName === "PRE"
        ? inner
        : wrap(format, inner, "`", "code");
    case "PRE": {
      if (format === "html") return `<pre><code>${inner}</code></pre>`;
      if (format === "text") return inner;
      const language =
        node.querySelector("code")?.className.match(/language-(\S+)/)?.[1] ??
        "";
      return `\`\`\`${language}\n${inner}\n\`\`\``;
    }
  }
  return format === "html" && blockTag.test(tag) && !node.querySelector(blocks)
    ? `<p>${inner}</p>`
    : inner;
}

function anchor(node: Element, inner: string, format: CopyFormat): string {
  const href = safeHref(node.getAttribute("href") ?? "");
  if (!href) return inner;
  // Message links state their label (empty for a raw destination). Other HTML,
  // including this module's own output, is raw when its text is the URL.
  const label = node.getAttribute("data-link-label") ?? node.textContent ?? "";
  if (!label || label === href || label === node.getAttribute("href"))
    return format === "html" ? link(format, href, href) : href;
  // Identity and channel locators read as their sigil-prefixed name alone.
  const buzz = parseBuzzLink(href);
  const plain =
    profileKey(href) || (buzz?.format === "legacy" && !buzz.messageId)
      ? label
      : `${label} (${href})`;
  return link(format, href, label, plain);
}

function safeHref(value: string): string | undefined {
  return profileKey(value) || parseBuzzLink(value)
    ? value
    : safeMessageUrl(value);
}

function link(
  format: CopyFormat,
  href: string,
  label: string,
  plain = label,
): string {
  if (format === "html")
    return `<a href="${escapeHtml(href)}">${escapeHtml(label)}</a>`;
  if (format === "markdown")
    return `[${label.replace(/[\\[\]]/g, "\\$&")}](${href})`;
  return plain;
}

function wrap(
  format: CopyFormat,
  inner: string,
  marker: string,
  tag: string,
): string {
  if (format === "html") return `<${tag}>${inner}</${tag}>`;
  return format === "markdown" && inner ? `${marker}${inner}${marker}` : inner;
}

function text(value: string, format: CopyFormat): string {
  return format === "html" ? escapeHtml(value) : value;
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"]/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[character] ??
      character,
  );
}

function clip(node: Text, range?: Range): string {
  const value = node.data;
  if (!range) return value;
  return value.slice(
    node === range.startContainer ? range.startOffset : 0,
    node === range.endContainer ? range.endOffset : value.length,
  );
}

/** A chip keeps its identity only when all of its text is selected. */
function whole(element: Element, range?: Range): boolean {
  if (!range) return true;
  const part = range.cloneRange();
  const bounds = element.ownerDocument.createRange();
  bounds.selectNodeContents(element);
  if (part.compareBoundaryPoints(Range.START_TO_START, bounds) < 0)
    part.setStart(bounds.startContainer, bounds.startOffset);
  if (part.compareBoundaryPoints(Range.END_TO_END, bounds) > 0)
    part.setEnd(bounds.endContainer, bounds.endOffset);
  return part.toString() === element.textContent;
}

// Preserve explicit breaks, blocks, and the tab/newline boundaries browsers use
// for table cells and rows. HTML output wraps leaf blocks instead.
function children(node: Node, format: CopyFormat, range?: Range): string {
  let text = "";
  let previous: Node | undefined;
  for (const child of node.childNodes) {
    if (range && !range.intersectsNode(child)) continue;
    const value = serializeNode(child, format, range);
    const separator =
      previous && format !== "html" ? siblingSeparator(previous, child) : "";
    if (separator === "\t") text += separator;
    else if (
      text &&
      value &&
      separator &&
      !text.endsWith(separator) &&
      !value.startsWith(separator)
    )
      text += separator;
    text += value;
    previous = child;
  }
  return text;
}

const blockTag =
  /^(DIV|P|LI|OL|UL|SECTION|TABLE|BLOCKQUOTE|PRE|H[1-6]|TR|THEAD|TBODY|TFOOT|TD|TH)$/;
const blocks =
  "div, p, li, ol, ul, section, table, blockquote, pre, h1, h2, h3, h4, h5, h6, tr, thead, tbody, tfoot, td, th";

function siblingSeparator(previous: Node, current: Node) {
  const previousTag = previous instanceof Element ? previous.tagName : "";
  const currentTag = current instanceof Element ? current.tagName : "";
  if (/^(TD|TH)$/.test(previousTag) || /^(TD|TH)$/.test(currentTag))
    return "\t";
  return blockTag.test(previousTag) || blockTag.test(currentTag) ? "\n" : "";
}

const editable =
  'input, textarea, [contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]';
const elementOf = (node: Node) =>
  node instanceof Element ? node : node.parentElement;

/** Message rows only; editors own their selections. */
function messageSelection(range: Range): boolean {
  const scope = elementOf(range.commonAncestorContainer);
  if (
    !scope ||
    [range.startContainer, range.endContainer].some((node) =>
      elementOf(node)?.closest(editable),
    )
  )
    return false;
  return (
    !!scope.closest("[data-message-id]") ||
    [...scope.querySelectorAll("[data-message-id]")].some((row) =>
      range.intersectsNode(row),
    )
  );
}

// Registered in the capture phase so it runs before `copyEmoji`
// (src/bundled/emoji/copy-emoji.ts), which bubbles on the same document and
// yields once the event is prevented. This walk emits shortcodes itself, so a
// message selection loses nothing by taking the event first.
function copyMessageSelection(event: ClipboardEvent) {
  const selection = document.getSelection();
  if (
    event.defaultPrevented ||
    !event.clipboardData ||
    !selection ||
    selection.isCollapsed ||
    !selection.rangeCount
  )
    return;
  const ranges = Array.from({ length: selection.rangeCount }, (_, index) =>
    selection.getRangeAt(index),
  );
  if (!ranges.every(messageSelection)) return;
  event.clipboardData.setData(
    "text/plain",
    serializeSelection(selection, "text"),
  );
  event.clipboardData.setData(
    "text/html",
    `<div data-buzz-copy="timeline">${serializeSelection(selection, "html")}</div>`,
  );
  event.preventDefault();
}

let surfaces = 0;
/** Timeline and thread surfaces share one document listener. */
export function useMessageSelectionCopy() {
  useEffect(() => {
    if (typeof document === "undefined") return;
    if (surfaces++ === 0)
      document.addEventListener("copy", copyMessageSelection, true);
    return () => {
      if (--surfaces === 0)
        document.removeEventListener("copy", copyMessageSelection, true);
    };
  }, []);
}
