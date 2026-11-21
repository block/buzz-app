/*
 * Vim's cursor: each message list keeps one message marked with
 * `data-message-cursor`, which the host paints like a selected message, while
 * focus goes to the composer, the sidebar, a menu or a popover. Focus or a
 * click on a message moves it there; scrolling keeps it on a message in view.
 */
import {
  focusTarget,
  messageListElements,
  messageListOf,
} from "../../features/messages/message-selection";

export const CURSOR = "data-message-cursor";
const ROW = "[data-message-id]";
const cursors = new WeakMap<HTMLElement, string>();

/** The list's own message rows, not a nested list's or an unavailable one. */
const rowsOf = (list: HTMLElement) =>
  [...list.querySelectorAll<HTMLElement>(ROW)].filter(
    (row) =>
      !!row.dataset.messageId &&
      messageListOf(row)?.element === list &&
      !row.closest('[inert], [hidden], [aria-hidden="true"]'),
  );

/** The list's cursor message, while it is rendered. */
function rendered(list: HTMLElement) {
  const id = cursors.get(list);
  return id
    ? rowsOf(list).find((row) => row.dataset.messageId === id)
    : undefined;
}

/** The marked cursor message in a list or pane. */
export const cursorRow = (root: ParentNode | undefined) =>
  root?.querySelector(`[${CURSOR}]`)?.closest<HTMLElement>(ROW) ?? undefined;

/** What the list shows: its scroll container's box within the window. */
function frameOf(list: HTMLElement) {
  let node: HTMLElement | null = list;
  while (node && !/auto|scroll|overlay/.test(getComputedStyle(node).overflowY))
    node = node.parentElement;
  const box = (node ?? list).getBoundingClientRect();
  return {
    top: Math.max(box.top, 0),
    bottom: Math.min(box.bottom, innerHeight),
  };
}

function shown(row: HTMLElement, frame: { top: number; bottom: number }) {
  const box = focusTarget(row).getBoundingClientRect();
  return box.height > 0 && box.bottom > frame.top && box.top < frame.bottom;
}

/** Point each list's cursor at a message in view, then mark it. */
function sync() {
  for (const list of messageListElements()) {
    const owner = messageListOf(list)?.list;
    if (!owner || !list.isConnected || !list.getClientRects().length) continue;
    const frame = frameOf(list);
    const id = cursors.get(list);
    const known = !!id && !!owner.row(id);
    const current = known ? rendered(list) : undefined;
    if (!current || !shown(current, frame)) {
      const visible = rowsOf(list).filter((row) => shown(row, frame));
      // Unset: the newest in view. Scrolled off: the nearest edge in view,
      // or the middle once it is no longer rendered.
      const next = !known
        ? visible.at(-1)
        : !current
          ? visible[Math.floor(visible.length / 2)]
          : focusTarget(current).getBoundingClientRect().top < frame.top
            ? visible[0]
            : visible.at(-1);
      if (next?.dataset.messageId) {
        cursors.set(list, next.dataset.messageId);
        // A message scrolled away hands its focus on, as Vim's cursor does.
        const active = document.activeElement;
        const row = active?.closest<HTMLElement>(ROW);
        if (
          row &&
          row.dataset.messageId === id &&
          active === focusTarget(row)
        ) {
          const box = focusTarget(next);
          if (!box.hasAttribute("tabindex")) box.tabIndex = -1;
          box.focus({ preventScroll: true });
        }
      }
    }
    const marked = rendered(list);
    const box = marked && focusTarget(marked);
    for (const stale of list.querySelectorAll(`[${CURSOR}]`))
      if (stale !== box && messageListOf(stale)?.element === list)
        stale.removeAttribute(CURSOR);
    box?.setAttribute(CURSOR, "");
  }
}

/** Track and mark cursors until the returned cleanup runs. */
export function trackCursor() {
  let frame = 0;
  const schedule = () => {
    frame ||= requestAnimationFrame(() => {
      frame = 0;
      sync();
    });
  };
  const move = (event: Event) => {
    const row =
      event.target instanceof Element
        ? event.target.closest<HTMLElement>(ROW)
        : null;
    const owner = row && messageListOf(row);
    const id = row?.dataset.messageId;
    if (owner && id && owner.list.row(id)) cursors.set(owner.element, id);
    schedule();
  };
  const observer = new MutationObserver(schedule);
  observer.observe(document.body, { childList: true, subtree: true });
  document.addEventListener("focusin", move, true);
  document.addEventListener("pointerdown", move, true);
  document.addEventListener("scroll", schedule, true);
  addEventListener("resize", schedule);
  schedule();
  return () => {
    cancelAnimationFrame(frame);
    observer.disconnect();
    document.removeEventListener("focusin", move, true);
    document.removeEventListener("pointerdown", move, true);
    document.removeEventListener("scroll", schedule, true);
    removeEventListener("resize", schedule);
    for (const box of document.querySelectorAll(`[${CURSOR}]`))
      box.removeAttribute(CURSOR);
  };
}
