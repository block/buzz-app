/*
 * Moving focus and scrolling for Vim keys. Lists, menus and messages keep
 * their own arrow-key behavior: a move is that arrow, pressed on the focus.
 * Only what nothing handles falls back to scrolling.
 */
import { currentCursor, cursorRow, messageRows } from "./cursor";
import {
  focused,
  openMenu,
  POPUP_LIST,
  press,
  ROW,
  selectField,
  SHEET,
  SIDEBAR,
  SUBVIEW,
  typing,
  TYPING,
  UNAVAILABLE,
} from "./dom";
import { host } from "./host";
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
import { lineItem, sameLine } from "./lines";

const MODAL = '[aria-modal="true"], dialog[open]';
/** A dialog that keeps its own focus; a sheet's messages are a view. */
const DIALOG = `[role="dialog"]:not(${SHEET})`;
const LINE = 64;
/** What j and k can walk to, fields included (see `selectField`). */
const ITEM =
  'a[href], button, summary, input, textarea, select, [contenteditable="true"], [tabindex]';
/** A dialog's panes: its navs and detail asides, and the rest of it. */
const DIALOG_PANE = "nav, aside";
/** Arrows here open a popup or change a value, so j and k step past it. */
const NO_ARROWS =
  '[aria-haspopup]:not([role^="menuitem"]), [role="combobox"], [role="radio"], [role="slider"], [role="spinbutton"], input[type="radio"], input[type="range"]';
const arrows = (origin: HTMLElement) => !origin.matches(NO_ARROWS);

/** The open modal on top; one that is closing no longer holds the keys. */
const topModal = () =>
  [...document.querySelectorAll<HTMLElement>(MODAL)]
    .filter(
      (modal) => !modal.closest(UNAVAILABLE) && !modal.matches("[data-closed]"),
    )
    .at(-1);

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
function visibleMessages(root: ParentNode | undefined) {
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
    scrollable(visibleMessages(modal ?? host.messages.active())[0]) ??
    (modal ? scrollable(modal.firstElementChild) : undefined) ??
    document.scrollingElement
  );
}

/**
 * The message a move starts from. A menu, dialog or the sidebar keeps its
 * own focus; a part of a message starts from its message (or stays, for
 * `go`); anywhere else starts from the conversation's cursor.
 */
function resume(parts = false) {
  const origin = focused();
  if (origin?.closest(`${MODAL}, ${POPUP_LIST}, ${DIALOG}, ${SIDEBAR}`))
    return origin;
  const row = origin?.closest<HTMLElement>(ROW) ?? currentCursor();
  if (!row) return origin;
  const box = host.messages.focusTarget(row);
  if (parts && origin && row.contains(origin)) return origin;
  if (origin !== box) host.messages.select(row);
  return box;
}

let moves = 0;
/** Ends every move still waiting on a frame: on stop, and when a newer move
 * starts, so an old one never moves focus or scrolls later. */
export function cancelMoves() {
  moves++;
}
/** Runs `run` on the next frame unless the move it belongs to was cancelled. */
function later(run: () => void, move = moves) {
  requestAnimationFrame(() => {
    if (move === moves) run();
  });
}

/** `j` / `k`: the next or previous item, or message from the cursor. */
export function step(down: boolean, settled = false) {
  if (!settled) cancelMoves();
  const origin = resume();
  const selected = host.messages.selected();
  // A selection scrolled away is rendered alone; bring it back and let its
  // neighbors render, so the move reaches the message beside it.
  if (
    selected &&
    !settled &&
    origin === host.messages.focusTarget(selected.row) &&
    !besideNeighbor(selected.row, down)
  ) {
    host.messages
      .focusTarget(selected.row)
      .scrollIntoView?.({ block: "nearest" });
    let frames = 30;
    const wait = () => {
      if (besideNeighbor(selected.row, down) || --frames <= 0) step(down, true);
      else later(wait);
    };
    later(wait);
    return;
  }
  if (
    origin &&
    arrows(origin) &&
    press(origin, down ? "ArrowDown" : "ArrowUp")
  ) {
    // Down past the newest message stays on it rather than typing.
    if (selected && typing()) host.messages.select(selected.row);
    return;
  }
  const next = origin && lineFrom(origin, down);
  if (next && !farOff(next, down)) return focusItem(next);
  // Text before the next item, or past what is rendered: scroll a line.
  (scrollable(next) ?? scroller())?.scrollBy({ top: down ? LINE : -LINE });
}

/**
 * What j and k walk from `origin`, in document order: the items of the
 * dialog pane holding it (see `dialogPane`), else a popover's, the
 * sidebar's, or a pane's. Undefined in messages and menus, which have their
 * own moves.
 */
function walkable(origin: HTMLElement | undefined) {
  if (!origin || origin.closest(`${ROW}, ${POPUP_LIST}`)) return;
  const modal = topModal();
  const pane = modal?.contains(origin) ? dialogPane(modal, origin) : undefined;
  const root =
    pane ??
    origin.closest<HTMLElement>(`${DIALOG}, ${SHEET}, ${SIDEBAR}`) ??
    currentPane();
  return root && itemsIn(root, modal && pane ? modal : undefined);
}

/** The items in `root`; in a dialog, only those of `root`'s own pane. */
function itemsIn(root: HTMLElement, modal?: HTMLElement) {
  return [...root.querySelectorAll<HTMLElement>(ITEM)].filter(
    (item) =>
      item.tabIndex >= 0 &&
      !item.matches(':disabled, [aria-disabled="true"]') &&
      !item.closest(`${ROW}, ${UNAVAILABLE}`) &&
      item.getClientRects().length > 0 &&
      (!modal || dialogPane(modal, item) === root),
  );
}

/** The dialog pane holding `element`: its nav or detail aside, else the dialog. */
function dialogPane(modal: HTMLElement, element: Element) {
  const pane = element.closest<HTMLElement>(DIALOG_PANE);
  return pane && modal.contains(pane) && pane !== modal ? pane : modal;
}

const box = (element: Element) => element.getBoundingClientRect();

/** The first item on the line below or above the focus. */
function lineFrom(origin: HTMLElement, down: boolean) {
  const items = walkable(origin);
  if (!items) return;
  const own = box(origin);
  // Not an item itself, such as a focused section: start from its edge.
  const edge = down ? own.top : own.bottom;
  const from = items.includes(origin)
    ? own
    : { top: edge, bottom: edge, left: own.left };
  return items[lineItem(items.map(box), from, down)];
}

/** More than a line out of view, so a move would skip what is between. */
function farOff(item: HTMLElement, down: boolean) {
  const { top, bottom } = scrollable(item)?.getBoundingClientRect() ?? {
    top: 0,
    bottom: innerHeight,
  };
  const near = box(item);
  return down ? near.top > bottom + LINE : near.bottom < top - LINE;
}

/** Focus an item, bringing it into view. */
function focusItem(
  item: HTMLElement,
  block: ScrollLogicalPosition = "nearest",
) {
  item.scrollIntoView?.({ block });
  focusKeyboardTarget(item);
  // A field is selected, not edited, so the next key still moves.
  if (item.matches(TYPING) && document.activeElement === item)
    selectField(item);
}

/** Of `items`, the first about `distance` px past `from`, or the last. */
function halfPageFrom(
  items: HTMLElement[],
  from: HTMLElement,
  distance: number,
  down: boolean,
) {
  const goal = from.getBoundingClientRect().top + (down ? distance : -distance);
  const top = (item: HTMLElement) => item.getBoundingClientRect().top;
  return down
    ? (items.find((item) => top(item) >= goal) ?? items.at(-1))
    : (items.filter((item) => top(item) <= goal).at(-1) ?? items[0]);
}

/**
 * `h` / `l`: left or right in lists and trees (→ on a message opens its
 * thread), else the item before or after on the same line.
 */
export function sideways(right: boolean) {
  cancelMoves();
  const origin = focused();
  if (!origin || press(origin, right ? "ArrowRight" : "ArrowLeft")) return;
  const items = walkable(origin) ?? [];
  const index = items.indexOf(origin);
  if (index < 0) return;
  const line = items.filter((item) => sameLine(box(item), box(origin)));
  const next = right
    ? line.find((item) => items.indexOf(item) > index)
    : line.filter((item) => items.indexOf(item) < index).at(-1);
  if (next) focusItem(next);
}

/** The list a message belongs to, with its rendered messages. */
function listRows(row: HTMLElement) {
  const list = host.messages.listOf(row)?.element;
  return list ? messageRows(list) : [];
}

/** Whether the message's rendered neighbor that way is the one beside it. */
function besideNeighbor(row: HTMLElement, down: boolean) {
  const rows = listRows(row);
  const neighbor = rows[rows.indexOf(row) + (down ? 1 : -1)];
  // Below the last rendered message, a newer one may still be rendering.
  if (!neighbor)
    return (
      !down || row.dataset.messageId === host.messages.listOf(row)?.newest()
    );
  const box = row.getBoundingClientRect();
  const near = neighbor.getBoundingClientRect();
  // ponytail: a fixed gap; rows sit flush or a margin apart.
  return (down ? near.top - box.bottom : box.top - near.bottom) < LINE;
}

/**
 * `gg` / `G`: the first or last menu, list or walked item (see `walkable`),
 * or the oldest loaded or newest message once scrolling there has rendered
 * it. Without any of those, just scroll.
 */
function edge(down: boolean) {
  cancelMoves();
  const origin = resume();
  const menu = origin?.closest<HTMLElement>(POPUP_LIST);
  if (menu) {
    const items = [
      ...menu.querySelectorAll<HTMLElement>(
        '[role^="menuitem"], [role="option"]',
      ),
    ].filter(
      (item) =>
        item.closest(POPUP_LIST) === menu &&
        item.getAttribute("aria-disabled") !== "true",
    );
    (down ? items.at(-1) : items[0])?.focus();
    return;
  }
  const row = origin?.closest<HTMLElement>(ROW);
  // A list moves its own selection to its first or last item.
  if (!row && origin && arrows(origin) && press(origin, down ? "End" : "Home"))
    return;
  const items = walkable(origin);
  const end = down ? items?.at(-1) : items?.[0];
  if (end) return focusItem(end);
  const target = scroller();
  if (!target) return;
  const list = row && host.messages.listOf(row)?.element;
  let frames = 60;
  let last = Number.NaN;
  const settle = () => {
    if (down && list && host.messages.selectNewest(list)) return;
    // The top can stop short of 0 at the history's edge; wait for rest.
    const oldest =
      !down && list && target.scrollTop === last && messageRows(list)[0];
    if (oldest) return host.messages.select(oldest);
    last = target.scrollTop;
    target.scrollTo({ top: down ? target.scrollHeight : 0 });
    if (list && --frames > 0) later(settle);
  };
  target.scrollTo({ top: down ? target.scrollHeight : 0 });
  if (list) later(settle);
}
export const top = () => edge(false);
export const bottom = () => edge(true);

/**
 * `<C-d>` / `<C-u>`: the message or walked item half a page below or above,
 * centred (Neovim's `<C-d>zz`); a list's own page keys; else half a page of
 * scrolling.
 */
export function halfPage(down: boolean) {
  cancelMoves();
  const origin = resume();
  const half = (element: Element | null | undefined) =>
    (scrollable(element)?.clientHeight ?? innerHeight) / 2;
  const row = origin?.closest<HTMLElement>(ROW);
  if (!row) {
    if (origin && arrows(origin) && press(origin, down ? "PageDown" : "PageUp"))
      return;
    const items = walkable(origin);
    const next =
      origin && items?.length
        ? halfPageFrom(items, origin, half(origin), down)
        : undefined;
    if (next && next !== origin) return focusItem(next, "center");
    const target = scroller();
    return target?.scrollBy({ top: (down ? 1 : -1) * half(target) });
  }
  const next = halfPageFrom(listRows(row), row, half(row), down);
  if (!next) return;
  host.messages.select(next);
  host.messages.focusTarget(next).scrollIntoView?.({ block: "center" });
}

/** Parts of a message that take focus: its author, links, files, reactions. */
const PART =
  'a[href], button:not(:disabled), summary, [tabindex]:not([tabindex="-1"])';

/**
 * The focused message, then its parts in order; undefined when the focus is
 * not in a message or it has no parts. Its hover toolbar is left to `go`.
 */
function messageStops() {
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
    ? { row, stops: [host.messages.focusTarget(row), ...parts] }
    : undefined;
}

/** Enter: the focused message, when it has a thread. */
export function threadRow() {
  const origin = focused();
  const row = origin?.closest<HTMLElement>(ROW);
  return row &&
    origin === host.messages.focusTarget(row) &&
    host.messages.hasThread(row)
    ? row
    : undefined;
}

/** Tab / Shift-Tab: the message's next or previous part, wrapping to itself. */
export function stepPart(forward: boolean) {
  cancelMoves();
  const found = messageStops();
  if (!found) return;
  const { row, stops } = found;
  const index = Math.max(0, stops.indexOf(focused() as HTMLElement));
  const next =
    stops[(index + (forward ? 1 : -1) + stops.length) % stops.length];
  if (next === stops[0]) host.messages.select(row);
  else focusKeyboardTarget(next);
}

/** Escape: back to the cursor's message, from a field, its parts or the
 * sidebar; from a thread's message box, to that thread's. */
export function leave() {
  cancelMoves();
  const origin = focused();
  const pane = currentPane();
  const view = origin?.closest<HTMLElement>(SUBVIEW) ?? pane;
  const row =
    origin?.closest<HTMLElement>(ROW) ??
    (view && view !== sidebar() ? cursorRow(view) : undefined) ??
    currentCursor();
  if (row && !topModal()) return host.messages.select(row);
  origin?.blur();
}

export function focusComposer() {
  cancelMoves();
  focusKeyboardTarget(composerFocusTarget());
}

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
  cancelMoves();
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
  const newest = cursorRow(pane) ?? visibleMessages(pane).at(-1);
  if (newest) return host.messages.select(newest);
  focusKeyboardTarget(
    composerIn(pane) ??
      pane.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]') ??
      undefined,
  );
}

/** Where focus last was in each dialog pane, to return there. */
const lastInPane = new WeakMap<HTMLElement, HTMLElement>();

/** A dialog's panes that have items, left to right. */
function dialogPanes(modal: HTMLElement) {
  return [modal, ...modal.querySelectorAll<HTMLElement>(DIALOG_PANE)]
    .filter((pane) => dialogPane(modal, pane) === pane)
    .map((pane) => ({ pane, items: itemsIn(pane, modal) }))
    .filter(({ items }) => items.length)
    .map((entry) => ({
      ...entry,
      left: Math.min(...entry.items.map((item) => box(item).left)),
    }))
    .sort((a, b) => a.left - b.left);
}

/** `<C-h>` / `<C-l>` in a dialog: its pane to the left or right. */
function focusDialogPane(modal: HTMLElement, right: boolean) {
  const origin = focused();
  const current =
    origin && modal.contains(origin) ? dialogPane(modal, origin) : undefined;
  if (current && origin) lastInPane.set(current, origin);
  const all = dialogPanes(modal);
  const index = all.findIndex(({ pane }) => pane === current);
  const next =
    all[index < 0 ? (right ? 0 : all.length - 1) : index + (right ? 1 : -1)];
  if (!next) return;
  const last = lastInPane.get(next.pane);
  focusItem(
    (last && next.items.includes(last) ? last : undefined) ??
      next.items.find((item) => item.matches('[aria-current="page"]')) ??
      // Content that scrolls before a dialog's fixed chrome, such as Close.
      next.items.find((item) => inView(item) && !!scrollable(item)) ??
      next.items.find((item) => inView(item)) ??
      (next.items[0] as HTMLElement),
  );
}

/** `<C-h>` / `<C-l>`: the pane to the left or right. */
export function focusPane(right: boolean) {
  cancelMoves();
  const modal = topModal();
  if (modal) return focusDialogPane(modal, right);
  const all = panes();
  const current = currentPane();
  const index = current ? all.indexOf(current) : right ? -1 : all.length;
  const next = all[index + (right ? 1 : -1)];
  if (next) enter(next);
}

/** `<C-k>`: this pane's messages, or the conversation's from the sidebar. */
export function focusMessages() {
  cancelMoves();
  const pane = currentPane();
  const workspace =
    pane && pane !== sidebar()
      ? pane
      : panes().find((candidate) => candidate !== sidebar());
  const newest = cursorRow(workspace) ?? visibleMessages(workspace).at(-1);
  if (newest) host.messages.select(newest);
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
  const origin = resume(true);
  if (!origin || !host.messages.openActions(origin)) return false;
  cancelMoves();
  // WebKit can leave focus on the item; the menu's keys need it inside.
  let frames = 10;
  const settle = () => {
    const menu = openMenu();
    if (menu?.contains(document.activeElement)) return;
    if (menu) menu.focus();
    else if (--frames > 0) later(settle);
  };
  settle();
  return true;
}
