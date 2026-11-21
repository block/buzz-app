/*
 * Moving focus and scrolling for Vim keys. Lists, menus and messages keep
 * their own arrow-key behavior: a move is that arrow, pressed on the focus.
 * Only what nothing handles falls back to scrolling.
 */
import { WHICH_KEY } from "./pending";
import {
  activeMessageList,
  focusTarget,
  selectedMessage,
  selectMessage,
} from "../../features/messages/message-selection";
import {
  composerFocusTarget,
  composerIn,
  focusKeyboardTarget,
  workspaces,
} from "../../app/focus-navigation";
import {
  conversationRows,
  CONVERSATION_LIST_LABEL,
} from "../channels/conversation-rows";

const ROW = "[data-message-id]";
const MODAL = '[aria-modal="true"], dialog[open]';
const UNAVAILABLE = '[hidden], [inert], [aria-hidden="true"]';
const TYPING =
  'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]';
const LINE = 64;

export const focused = () => {
  const element = document.activeElement;
  return element instanceof HTMLElement && element !== document.body
    ? element
    : undefined;
};
export const typing = () => !!focused()?.matches(TYPING);
/** The open modal on top; one that is closing no longer holds the keys. */
const topModal = () =>
  [...document.querySelectorAll<HTMLElement>(MODAL)]
    .filter(
      (modal) => !modal.closest(UNAVAILABLE) && !modal.matches("[data-closed]"),
    )
    .at(-1);

/** Press a key on the focus as if typed; true when something handled it. */
export function press(target: HTMLElement, key: string) {
  const event = new KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
    composed: true,
  });
  target.dispatchEvent(event);
  return event.defaultPrevented;
}

function inView(element: HTMLElement, frame?: DOMRect) {
  const box = element.getBoundingClientRect();
  const { top, bottom } = frame ?? { top: 0, bottom: innerHeight };
  return (
    box.height > 0 &&
    box.bottom > top &&
    box.top < bottom &&
    !element.closest(UNAVAILABLE)
  );
}

/** Messages showing in `root`, oldest first. */
export function visibleMessages(root: ParentNode | undefined) {
  if (!root) return [];
  return [...root.querySelectorAll<HTMLElement>(ROW)].filter(
    (row) => !!row.dataset.messageId && inView(row),
  );
}

function scrollable(element: Element | null | undefined) {
  for (
    let node = element instanceof HTMLElement ? element : null;
    node && node !== document.documentElement;
    node = node.parentElement
  ) {
    if (
      /auto|scroll|overlay/.test(getComputedStyle(node).overflowY) &&
      node.scrollHeight > node.clientHeight + 1
    )
      return node;
  }
}

/** What scrolls: the focus's container, else the active conversation. */
function scroller() {
  const modal = topModal();
  return (
    scrollable(focused()) ??
    scrollable(visibleMessages(modal ?? activeMessageList())[0]) ??
    (modal ? scrollable(modal.firstElementChild) : undefined) ??
    document.scrollingElement
  );
}

/** Scroll, then keep a selected message selected among those in view. */
function scrollThen(
  move: (target: Element) => void,
  pick: (rows: HTMLElement[]) => HTMLElement | undefined,
) {
  const target = scroller();
  if (!target) return;
  const hadSelection = !!selectedMessage();
  move(target);
  if (!hadSelection) return;
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      const row = pick(visibleMessages(target));
      if (row) selectMessage(row);
    }),
  );
}

/** `j` / `k`: the next or previous item, or the newest message from nowhere. */
export function step(down: boolean) {
  const origin = focused();
  const selected = selectedMessage();
  if (origin && press(origin, down ? "ArrowDown" : "ArrowUp")) {
    // Down past the newest message stays on it rather than typing.
    if (selected && typing()) selectMessage(selected.element);
    return;
  }
  if (!origin) {
    const newest = visibleMessages(topModal() ?? activeMessageList()).at(-1);
    if (newest) return selectMessage(newest);
  }
  // Sidebar rows are Tab stops without arrow keys; step between them.
  if (origin && sidebar()?.contains(origin)) {
    const rows = conversationRows().filter(
      (row) => row.getClientRects().length,
    );
    const after = (row: HTMLElement) =>
      !!(
        origin.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING
      );
    const next = down
      ? rows.find(after)
      : rows.filter((row) => row !== origin && !after(row)).at(-1);
    if (next) {
      next.scrollIntoView({ block: "nearest" });
      return focusKeyboardTarget(next);
    }
    return;
  }
  // Past what is rendered, scrolling loads more.
  scroller()?.scrollBy({ top: down ? LINE : -LINE });
}

/** `h` / `l`: left or right in lists and trees; → on a message opens its thread. */
export function sideways(right: boolean) {
  const origin = focused();
  if (origin) press(origin, right ? "ArrowRight" : "ArrowLeft");
}

export const top = () =>
  scrollThen(
    (target) => target.scrollTo({ top: 0 }),
    (rows) => rows[0],
  );
export const bottom = () =>
  scrollThen(
    (target) => target.scrollTo({ top: target.scrollHeight }),
    (rows) => rows.at(-1),
  );
/** Half a page, keeping the selection near the middle (Neovim's `<C-d>zz`). */
export const halfPage = (down: boolean) =>
  scrollThen(
    (target) =>
      target.scrollBy({ top: ((down ? 1 : -1) * target.clientHeight) / 2 }),
    (rows) => rows[Math.floor(rows.length / 2)],
  );

/** Parts of a message that take focus: its author, links, files, reactions. */
const PART =
  'a[href], button:not(:disabled), summary, [tabindex]:not([tabindex="-1"])';

/**
 * The focused message, then its parts in order; undefined when the focus is
 * not in a message or it has no parts. Its hover toolbar is left to `go`.
 */
export function messageStops() {
  const origin = focused();
  const row = origin?.closest<HTMLElement>(ROW);
  if (!origin || !row || origin.matches(TYPING)) return;
  const parts = [...row.querySelectorAll<HTMLElement>(PART)].filter(
    (part) =>
      part.closest(ROW) === row &&
      !part.closest('[role="group"]') &&
      part.getClientRects().length > 0 &&
      !part.closest(UNAVAILABLE),
  );
  return parts.length
    ? { row, stops: [focusTarget(row), ...parts] }
    : undefined;
}

/** Tab / Shift-Tab: the message's next or previous part, wrapping to itself. */
export function stepPart(forward: boolean) {
  const found = messageStops();
  if (!found) return;
  const { row, stops } = found;
  const index = Math.max(0, stops.indexOf(focused() as HTMLElement));
  const next =
    stops[(index + (forward ? 1 : -1) + stops.length) % stops.length];
  if (next === stops[0]) selectMessage(row);
  else focusKeyboardTarget(next);
}

/** Escape: from a message's part back to the message; else leave the field. */
export function leave() {
  const origin = focused();
  const row = origin?.closest<HTMLElement>(ROW);
  if (origin && row && !origin.matches(TYPING) && origin !== focusTarget(row))
    return selectMessage(row);
  origin?.blur();
}

export const focusComposer = () => focusKeyboardTarget(composerFocusTarget());

function sidebar() {
  const list = document.querySelector<HTMLElement>(
    `nav[aria-label="${CONVERSATION_LIST_LABEL}"]`,
  );
  return list?.getClientRects().length && !list.closest(UNAVAILABLE)
    ? list
    : undefined;
}

/** The open conversation's sidebar row, focused and scrolled into view. */
export function revealConversation() {
  const rows = conversationRows();
  const row =
    rows.find(
      (candidate) => candidate.getAttribute("aria-current") === "page",
    ) ?? rows[0];
  if (!row || !sidebar()?.contains(row)) return false;
  row.scrollIntoView({ block: "nearest" });
  focusKeyboardTarget(row);
  return true;
}

/** Sidebar, conversation and side panel, left to right. */
function panes() {
  const list = sidebar();
  return [...(list ? [list] : []), ...workspaces()]
    .filter(
      (pane) => pane.getClientRects().length && !pane.closest(UNAVAILABLE),
    )
    .sort(
      (a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left,
    );
}

const currentPane = () => {
  const origin = focused();
  return origin ? panes().find((pane) => pane.contains(origin)) : undefined;
};

/** Focus a pane without typing into it: its newest message, else its entry. */
function enter(pane: HTMLElement) {
  if (pane === sidebar()) return revealConversation();
  const newest = visibleMessages(pane).at(-1);
  if (newest) return selectMessage(newest);
  focusKeyboardTarget(
    composerIn(pane) ??
      pane.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]') ??
      undefined,
  );
}

/** `<C-h>` / `<C-l>`: the pane to the left or right. */
export function focusPane(right: boolean) {
  const all = panes();
  const current = currentPane();
  const index = current ? all.indexOf(current) : right ? -1 : all.length;
  const next = all[index + (right ? 1 : -1)];
  if (next) enter(next);
}

/** `<C-k>`: this pane's messages, or the conversation's from the sidebar. */
export function focusMessages() {
  const pane = currentPane();
  const workspace =
    pane && pane !== sidebar()
      ? pane
      : panes().find((candidate) => candidate !== sidebar());
  const newest = visibleMessages(workspace).at(-1);
  if (newest) selectMessage(newest);
}

/** Where `<leader>/` searches: the sidebar's conversations, or a conversation. */
export const inSidebar = () => {
  const origin = focused();
  return !!origin && !!sidebar()?.contains(origin);
};

/**
 * `go`: open the focused item's own action menu, the one right-click, the
 * Menu key and Shift+F10 open. False when the focus has none.
 */
export function openActions() {
  const origin = focused();
  if (!origin || !press(origin, "ContextMenu")) return false;
  // WebKit can leave focus on the item; the menu's keys need it inside.
  let frames = 10;
  const settle = () => {
    const menu = [
      ...document.querySelectorAll<HTMLElement>('[role="menu"][data-open]'),
    ].find((popup) => !popup.closest(`[${WHICH_KEY}]`));
    if (menu?.contains(document.activeElement)) return;
    if (menu) menu.focus();
    else if (--frames > 0) requestAnimationFrame(settle);
  };
  settle();
  return true;
}
