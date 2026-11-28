/*
 * The page as Vim keys read it: where focus is, whether it is typing, and the
 * host surfaces the keys move through. The other modules read the page here.
 */

export const ROW = "[data-message-id]";
export const UNAVAILABLE = '[hidden], [inert], [aria-hidden="true"]';
export const TYPING =
  'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]';
export const SIDEBAR = 'aside[aria-label="Sidebar"]';
/** A menu or a choice list (an open Select): its keys move between options. */
export const POPUP_LIST = '[role="menu"], [role="listbox"]';
/** A sheet over the conversation, such as an inline thread. It is a view
 * with its own messages and message box, not an overlay. */
export const SHEET = "[data-details-sheet-surface]";
/** Views beside or over a conversation, each with its own cursor. */
export const SUBVIEW = `[data-panel-workspace], ${SHEET}`;
/** Marks the which-key menu, whose own clicks and keys belong to the sequence. */
export const WHICH_KEY = "data-vim-which-key";

export const focused = () => {
  const element = document.activeElement;
  return element instanceof HTMLElement && element !== document.body
    ? element
    : undefined;
};

/** Typing in a field; a selected field (see `selectField`) is not. */
export const typing = () => {
  const element = focused();
  return !!element?.matches(TYPING) && !element.hasAttribute(FIELD_SELECTED);
};

/** An open menu, not the which-key menu; focus reaches it a frame later. */
export const openMenu = () =>
  [...document.querySelectorAll<HTMLElement>('[role="menu"][data-open]')].find(
    (menu) => !menu.closest(`[${WHICH_KEY}]`),
  );

/** In an open menu, or one about to take focus, its own keys win. */
export const inMenu = () =>
  !!document.activeElement?.closest('[role="menu"]') ||
  !!document.querySelector('[role="menu"][data-open]');

/** Press a key on `target` as if typed; true when something handled it. */
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

/** The host's mark for a field that holds focus without being edited. */
const FIELD_SELECTED = "data-field-selected";
const editors = new WeakMap<HTMLElement, () => void>();

/**
 * Keep focus on `field` without editing it, as Vim's normal mode: moves still
 * run from it and nothing types into it. i or Enter edits it, as do a click
 * in it and focus leaving it.
 */
export function selectField(field: HTMLElement) {
  if (editors.has(field)) return;
  const keydown = (event: KeyboardEvent) => {
    if (
      (event.key === "i" || event.key === "Enter") &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey &&
      !event.shiftKey
    ) {
      event.preventDefault();
      event.stopPropagation();
      edit();
    }
  };
  // Every key a move doesn't take would type; the input never happens.
  const refuse = (event: Event) => event.preventDefault();
  const edit = () => {
    editors.delete(field);
    field.removeAttribute(FIELD_SELECTED);
    field.removeEventListener("keydown", keydown);
    field.removeEventListener("beforeinput", refuse);
    field.removeEventListener("blur", edit);
    field.removeEventListener("pointerdown", edit);
  };
  editors.set(field, edit);
  field.setAttribute(FIELD_SELECTED, "");
  field.addEventListener("keydown", keydown);
  field.addEventListener("beforeinput", refuse);
  field.addEventListener("blur", edit);
  field.addEventListener("pointerdown", edit);
}

/** Edit the selected field holding focus, if any. */
export function editField() {
  const field = focused();
  if (field) editors.get(field)?.();
}
