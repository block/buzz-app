/*
 * Vim's cursor is where focus is, so there is only ever one. Each message
 * list remembers its selected message, so focus can return to it; only a move
 * or a click changes it, and scrolling never does. The message holding focus
 * in a focused window is marked with `data-message-cursor`; a remembered one
 * elsewhere is not. It shows Buzz's usual focus ring. Outside
 * a field, focus stays on a message: an opened conversation, a click in the
 * timeline or sidebar and focus falling to nothing all return focus to it,
 * without scrolling.
 */
import { CONVERSATION_LIST_LABEL } from "../channels/conversation-rows";
import type { MessageListHandle } from "../../plugins/author";
import { host } from "./host";
import { ROW, SHEET, SUBVIEW, TYPING, UNAVAILABLE, WHICH_KEY } from "./dom";

export const CURSOR = "data-message-cursor";
const WORKSPACE = "[data-channel-workspace]";
/** Surfaces that own focus while open or closing, until they return it: modal
 * dialogs and menus always, other dialogs (popovers, preview cards) while
 * focus is in one. A sheet is a view, not an overlay. */
const OVERLAY = `[aria-modal="true"]:not([data-closed]), dialog[open], [role="menu"], [${WHICH_KEY}]`;
const POPOVER = `[role="dialog"]:not(${SHEET})`;
/** Clicks in the sidebar's conversations leave focus on the cursor. */
const CONVERSATION_NAV = `nav[aria-label="${CONVERSATION_LIST_LABEL}"]`;

type Cursor = {
  id: string;
  owner: MessageListHandle;
  /** Neighbors, for when the message is deleted. */
  before?: string | undefined;
  after?: string | undefined;
  release?: (() => void) | undefined;
};
/** A conversation's main list is keyed by conversation, so it survives a visit. */
const cursors = new Map<string | HTMLElement, Cursor>();
let lastList: HTMLElement | undefined;

/** The list's own message rows, not a nested list's or an unavailable one. */
export const messageRows = (list: HTMLElement) =>
  [...list.querySelectorAll<HTMLElement>(ROW)].filter(
    (row) =>
      !!row.dataset.messageId &&
      host.messages.listOf(row)?.element === list &&
      !row.closest(UNAVAILABLE),
  );

function keyOf(list: HTMLElement) {
  const workspace = list.closest<HTMLElement>(WORKSPACE);
  // A side panel's or a sheet's thread has its own cursor.
  const outermost =
    workspace &&
    !list.closest(SUBVIEW) &&
    !host.messages
      .lists()
      .some(
        (other) =>
          other !== list && other.contains(list) && workspace.contains(other),
      );
  return outermost
    ? `conversation:${workspace.dataset.channelWorkspace}`
    : list;
}

function place(list: HTMLElement, owner: MessageListHandle, id: string) {
  const key = keyOf(list);
  const current = cursors.get(key);
  if (current?.id === id && current.owner === owner) return current;
  current?.release?.();
  const next: Cursor = { id, owner, release: owner.keepMounted(id) };
  cursors.set(key, next);
  return next;
}

/** The list's remembered message, when it is rendered. */
function remembered(list: HTMLElement) {
  const id = cursors.get(keyOf(list))?.id;
  return id
    ? messageRows(list).find((row) => row.dataset.messageId === id)
    : undefined;
}

/** The remembered message in a list or pane, preferring the last moved in. */
export function cursorRow(root: Node | null | undefined) {
  if (!root) return;
  const lists = host.messages.lists().filter((list) => root.contains(list));
  if (lastList && lists.includes(lastList)) lists.unshift(lastList);
  for (const list of lists) {
    const row = remembered(list);
    if (row) return row;
  }
}

/** The cursor of the list last moved in, else of the open conversation. */
export function currentCursor() {
  const main = document.querySelector<HTMLElement>(
    `#main-content ${WORKSPACE}`,
  );
  return (
    (lastList?.isConnected ? remembered(lastList) : undefined) ??
    cursorRow(main)
  );
}

/** The newest rendered message of `list`. */
function newestRow(list: HTMLElement) {
  const id = host.messages.listOf(list)?.newest();
  return id
    ? messageRows(list).find((row) => row.dataset.messageId === id)
    : undefined;
}

/** The newest message of the thread `root` opened, wherever it shows: the
 * last other list that also shows its root, such as a sheet or a tab. */
function threadNewest(root: HTMLElement) {
  const own = host.messages.listOf(root)?.element;
  const thread = host.messages
    .lists()
    .filter(
      (list) =>
        list !== own &&
        list.isConnected &&
        messageRows(list).some(
          (row) => row.dataset.messageId === root.dataset.messageId,
        ),
    )
    .at(-1);
  return thread && newestRow(thread);
}

let claimFocus: ((find: () => HTMLElement | undefined) => void) | undefined;
/**
 * Give focus to what `find` returns once it renders, and keep it there until
 * the reader's next key or click: an opened thread's message, say, rather
 * than its message box.
 */
export const claim = (find: () => HTMLElement | undefined) =>
  claimFocus?.(find);

const overlayOpen = () =>
  !!document.querySelector(OVERLAY) ||
  !!document.activeElement?.closest(POPOVER);
const isNowhere = () =>
  !document.activeElement || document.activeElement === document.body;

/** Focus a message without scrolling: only a move scrolls. */
function focusMessage(row: HTMLElement) {
  const box = host.messages.focusTarget(row);
  if (!box.hasAttribute("tabindex")) box.tabIndex = -1;
  if (document.activeElement !== box) box.focus({ preventScroll: true });
}

/** Set each list's cursor, newest first and a neighbor after a deletion. */
function mark() {
  for (const [key, cursor] of cursors)
    if (key instanceof HTMLElement && !key.isConnected) {
      cursor.release?.();
      cursors.delete(key);
    }
  for (const list of host.messages.lists()) {
    const owner = host.messages.listOf(list);
    if (!owner || !list.isConnected) continue;
    const previous = cursors.get(keyOf(list));
    const id =
      previous && owner.has(previous.id)
        ? previous.id
        : ([previous?.after, previous?.before].find(
            (near) => near && owner.has(near),
          ) ?? owner.newest());
    if (!id) continue;
    const cursor = place(list, owner, id);
    const rows = messageRows(list);
    const index = rows.findIndex((row) => row.dataset.messageId === cursor.id);
    const row = rows[index];
    if (row) {
      cursor.before = rows[index - 1]?.dataset.messageId;
      cursor.after = rows[index + 1]?.dataset.messageId;
    }
    // Only where focus is: not a nested list's row, a menu or another window.
    const box =
      row && document.hasFocus() && document.activeElement?.closest(ROW) === row
        ? host.messages.focusTarget(row)
        : undefined;
    for (const stale of list.querySelectorAll(`[${CURSOR}]`))
      if (stale !== box && host.messages.listOf(stale)?.element === list)
        stale.removeAttribute(CURSOR);
    box?.setAttribute(CURSOR, "");
  }
}

/** Track and mark cursors, and keep focus on them, until cleanup runs. */
export function trackCursor() {
  let frame = 0;
  /** What takes focus until the reader's own input, such as a just-opened
   * conversation's cursor rather than its composer. */
  let claimed: (() => HTMLElement | undefined) | undefined;
  let shown: string | undefined;
  let clicked = false;
  /** The reader's last input was the pointer, which may use the toolbar. */
  let pointing = false;
  /** A thread summary focus came back to from outside its message, as a
   * closing thread returns it. */
  let returnedTo: Element | undefined;
  /** Where focus last was, to tell who owns it once it falls to nothing. */
  let lastFocus: Element | undefined;
  const sync = () => {
    frame = 0;
    // Place each list's cursor, move focus, then mark where focus ended up.
    mark();
    settle();
    mark();
  };
  const settle = () => {
    const workspace = document.querySelector<HTMLElement>(
      `#main-content ${WORKSPACE}`,
    );
    // A conversation opened: its cursor takes focus. A blank workspace is one
    // still loading, not a new conversation, so the same one coming back
    // after it opens nothing; leaving the page does.
    const open = workspace?.dataset.channelWorkspace;
    if (!workspace) shown = undefined;
    else if (open && open !== shown) {
      shown = open;
      claimed = () => cursorRow(workspace);
    }
    if (overlayOpen()) return;
    const active = document.activeElement;
    const nowhere = isNowhere();
    const typing = !!active?.matches(TYPING);
    const inMessage = !!active?.closest(ROW);
    if (claimed) {
      const row = claimed();
      if (row) {
        // Kept until the reader's own input, so a late handoff (a dialog's
        // return focus, the composer's) cannot take focus after it.
        focusMessage(row);
        return;
      }
    }
    // A message's hover toolbar is not a stop, nor its thread summary when
    // a closing thread hands focus back: by keyboard, the message takes it.
    const returned = !!active && active === returnedTo;
    returnedTo = undefined;
    const handedBack =
      active?.closest(`${ROW} [role="group"]`) ?? (returned ? active : null);
    if (handedBack && !pointing) {
      const row = handedBack.closest<HTMLElement>(ROW);
      if (row) focusMessage(row);
      return;
    }
    const afterClick = clicked;
    clicked = false;
    if (afterClick && !typing && !inMessage && !nowhere) {
      const row = currentCursor();
      if (row) focusMessage(row);
    }
    // Focus can pass through nothing on its way back; restore only if it
    // stays. A menu or dialog that had it returns it itself, a frame or two
    // later; if none does, the next move still starts at the cursor.
    if (nowhere && !lastFocus?.closest(`${OVERLAY}, [role="dialog"]`))
      requestAnimationFrame(() => {
        const row = currentCursor();
        if (isNowhere() && !overlayOpen() && row) focusMessage(row);
      });
  };
  const schedule = () => {
    frame ||= requestAnimationFrame(sync);
  };
  const focusin = (event: Event) => {
    const row =
      event.target instanceof Element
        ? event.target.closest<HTMLElement>(ROW)
        : null;
    const owner = row && host.messages.listOf(row);
    const id = row?.dataset.messageId;
    if (owner && id && owner.has(id)) {
      place(owner.element, owner, id);
      lastList = owner.element;
    }
    if (event.type === "focusin" && event.target instanceof Element)
      lastFocus = event.target;
    const from = (event as FocusEvent).relatedTarget;
    if (
      event.type === "focusin" &&
      row &&
      (event.target as Element).matches("button[data-thread-summary]") &&
      !(from instanceof Node && row.contains(from))
    )
      returnedTo = event.target as Element;
    schedule();
  };
  /** Input outside a dialog chooses where focus goes; in one, it is the dialog's. */
  const choose = (event: Event) => {
    pointing = event.type === "pointerdown";
    // A click counts only until the next input, even one that settles nothing.
    clicked = false;
    if (!overlayOpen()) claimed = undefined;
  };
  const claim = (find: () => HTMLElement | undefined) => {
    claimed = find;
    schedule();
  };
  claimFocus = claim;
  const pointerdown = (event: PointerEvent) => {
    choose(event);
    focusin(event);
  };
  const click = (event: MouseEvent) => {
    const target = event.target instanceof Element ? event.target : null;
    if (
      target &&
      (target.closest(CONVERSATION_NAV) || host.messages.listOf(target))
    )
      clicked = true;
    // Opening a thread, as opening a conversation, selects its newest
    // message rather than its message box, also as its replies load. Reply
    // is how to type in it.
    const root = target
      ?.closest("button[data-thread-summary]")
      ?.closest<HTMLElement>(ROW);
    if (root) claim(() => threadNewest(root));
    schedule();
  };
  // A message's own content, such as a streaming reply, can't move a cursor;
  // rows added, removed or re-keyed can.
  const insideRow = (node: Node) =>
    !!(
      node instanceof Element ? node : node.parentElement
    )?.parentElement?.closest(ROW);
  const observer = new MutationObserver((records) => {
    if (!records.every((record) => insideRow(record.target))) schedule();
  });
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributeFilter: ["data-channel-workspace"],
  });
  document.addEventListener("focusin", focusin, true);
  document.addEventListener("focusout", schedule, true);
  document.addEventListener("pointerdown", pointerdown, true);
  document.addEventListener("click", click, true);
  addEventListener("keydown", choose, true);
  addEventListener("focus", schedule);
  addEventListener("blur", schedule);
  schedule();
  return () => {
    cancelAnimationFrame(frame);
    observer.disconnect();
    document.removeEventListener("focusin", focusin, true);
    document.removeEventListener("focusout", schedule, true);
    document.removeEventListener("pointerdown", pointerdown, true);
    document.removeEventListener("click", click, true);
    removeEventListener("keydown", choose, true);
    removeEventListener("focus", schedule);
    removeEventListener("blur", schedule);
    // Disabling finishes after a render, so a re-enable may already own the
    // shared state; leave it to that tracker.
    if (claimFocus !== claim) return;
    claimFocus = undefined;
    for (const cursor of cursors.values()) cursor.release?.();
    cursors.clear();
    lastList = undefined;
    for (const box of document.querySelectorAll(`[${CURSOR}]`))
      box.removeAttribute(CURSOR);
  };
}
