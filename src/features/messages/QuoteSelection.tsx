import { useCallback, useEffect, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { QuotesIcon } from "../../shared/design-system/icons/index";
import { Button } from "../../shared/design-system/ui/Button";
import { buzzCopyDocument } from "./composer-clipboard";
import { composerSchema } from "./composer-document";
import { useMessageEditScope } from "./MessageEditScope";
import { serializeNode } from "./selection-copy";
import styles from "./Messages.module.css";

const elementOf = (node: Node) =>
  node instanceof Element ? node : node.parentElement;

/** The selected part of one message body in `scroller`, or null. A
 * triple-click ends the range at the start of the next block, past the body;
 * a tail with no text still quotes just the body. */
export function quotableSelection(
  scroller: Element,
  selection: Selection | null,
): { body: Element; range: Range } | null {
  if (!selection || selection.isCollapsed || selection.rangeCount !== 1)
    return null;
  const range = selection.getRangeAt(0);
  const body = elementOf(range.startContainer)?.closest("[data-message-body]");
  // Nested surfaces, such as a thread inside a preview, quote into their own.
  if (
    !body?.closest("[data-message-id]") ||
    body.closest("[data-message-scroller]") !== scroller
  )
    return null;
  let quoted = range;
  if (!body.contains(range.endContainer)) {
    const tail = range.cloneRange();
    tail.setStartAfter(body);
    if (tail.toString().trim()) return null;
    quoted = range.cloneRange();
    quoted.setEnd(body, body.childNodes.length);
  }
  return quoted.toString().trim() ? { body, range: quoted } : null;
}

/** The selection as the composer's own blocks: a quote, then an empty line
 * for the reply. Built like a paste of the same selection, so mentions stay
 * text and notify no one. */
export function quoteDocument(body: Element, range: Range) {
  const copied = buzzCopyDocument(
    `<div data-buzz-copy="timeline">${serializeNode(body, "html", range)}</div>`,
  );
  if (!copied?.textContent.trim()) return;
  const { nodes } = composerSchema;
  return nodes.doc.create(null, [
    nodes.blockquote.create(null, copied.content),
    nodes.paragraph.create(),
  ]);
}

/** The selection's first and last line boxes, within the timeline's bounds. */
type Anchor = { first: DOMRect; last: DOMRect; bounds: DOMRect };

/** A Quote action beside a text selection in one message, for this
 * timeline's composer. Portaled: the rows' DOM belongs to their renderers. */
export function QuoteSelection({
  scroller,
}: {
  scroller: RefObject<HTMLElement | null>;
}) {
  const scope = useMessageEditScope();
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  // Content-sized, so one measurement serves every placement.
  const measure = useCallback((node: HTMLDivElement | null) => {
    if (node) setSize({ width: node.offsetWidth, height: node.offsetHeight });
  }, []);

  useEffect(() => {
    const element = scroller.current;
    if (!scope || !element) return;
    let frame = 0;
    let dragging = false;
    let shown = false;
    const read = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const quotable =
          !dragging && scope.quote?.available()
            ? quotableSelection(element, document.getSelection())
            : null;
        const next = quotable && anchorOf(quotable.range, element);
        shown = !!next;
        setAnchor(next);
      });
    };
    const down = () => {
      dragging = true;
      shown = false;
      setAnchor(null);
    };
    // Escape dismisses the action before a parent surface handles it.
    const dismiss = (event: KeyboardEvent) => {
      if (!shown || event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      event.stopPropagation();
      shown = false;
      setAnchor(null);
      document.getSelection()?.removeAllRanges();
    };
    // A hidden timeline, such as a retained thread pane, leaves no action.
    const visibility =
      typeof IntersectionObserver === "function"
        ? new IntersectionObserver(read)
        : undefined;
    visibility?.observe(element);
    const up = () => {
      if (!dragging) return;
      dragging = false;
      read();
    };
    document.addEventListener("selectionchange", read);
    element.addEventListener("pointerdown", down);
    element.addEventListener("scroll", read, { passive: true });
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    window.addEventListener("resize", read);
    window.addEventListener("keydown", dismiss, true);
    return () => {
      cancelAnimationFrame(frame);
      visibility?.disconnect();
      window.removeEventListener("keydown", dismiss, true);
      document.removeEventListener("selectionchange", read);
      element.removeEventListener("pointerdown", down);
      element.removeEventListener("scroll", read);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      window.removeEventListener("resize", read);
    };
  }, [scope, scroller]);

  const quote = () => {
    const element = scroller.current;
    const selection = document.getSelection();
    const quotable = element && quotableSelection(element, selection);
    const doc = quotable
      ? quoteDocument(quotable.body, quotable.range)
      : undefined;
    if (!selection || !doc || !scope?.quote) return;
    const range = selection.getRangeAt(0);
    // Drop the timeline range before the composer takes focus; clearing it
    // afterwards would also clear the composer's new caret.
    selection.removeAllRanges();
    if (scope.quote.insert(doc)) setAnchor(null);
    else selection.addRange(range);
  };

  if (!anchor) return null;
  // Below the selection's last line, or above its first when that would leave
  // the timeline.
  const { first, last, bounds } = anchor;
  const gap = 6;
  const below = last.bottom + gap + size.height <= bounds.bottom;
  const top = below
    ? last.bottom + gap
    : Math.max(bounds.top, first.top - gap - size.height);
  const left = Math.max(
    bounds.left,
    Math.min(
      (below ? last.right : first.left) - size.width / 2,
      bounds.right - size.width,
    ),
  );
  return createPortal(
    <div ref={measure} className={styles.quoteSelection} style={{ top, left }}>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        // Keep the selection through the press; the click reads it.
        onPointerDown={(event) => event.preventDefault()}
        onClick={quote}
      >
        <QuotesIcon size={14} aria-hidden="true" /> Quote
      </Button>
    </div>,
    document.body,
  );
}

/** Null once the selection scrolls out of view or its timeline is hidden. */
function anchorOf(range: Range, scroller: Element): Anchor | null {
  const rects = range.getClientRects();
  const first = rects[0];
  const last = rects[rects.length - 1];
  const bounds = scroller.getBoundingClientRect();
  if (
    !first ||
    !last ||
    last.bottom < bounds.top ||
    first.top > bounds.bottom ||
    scroller.checkVisibility?.() === false ||
    scroller.closest("[inert]")
  )
    return null;
  return { first, last, bounds };
}
