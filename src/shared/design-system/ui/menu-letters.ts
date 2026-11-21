import {
  useCallback,
  useRef,
  useSyncExternalStore,
  type KeyboardEvent,
  type RefCallback,
} from "react";

/*
 * Menu letters: while something (such as a keyboard plugin) turns them on,
 * every menu item shows one key at its trailing edge and runs on that key.
 * Off by default, so menus keep Base UI's typeahead.
 */
const holders = new Set<{ reserved: string }>();
const listeners = new Set<() => void>();
const publish = () => {
  for (const listener of listeners) listener();
};

/**
 * Turn letters on for every menu until the returned release is called.
 * `reserved` keys are never assigned, so the caller keeps them in menus
 * (a Vim layer keeps `j` and `k` for moving).
 */
export function enableMenuLetters(reserved = "") {
  const holder = { reserved: reserved.toLowerCase() };
  holders.add(holder);
  publish();
  return () => {
    if (holders.delete(holder)) publish();
  };
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const lettersOn = () => holders.size > 0;
const reservedKeys = () =>
  [...holders].map(({ reserved }) => reserved).join("");

/**
 * One key per item, in order. A fixed key is kept; the rest take the first
 * free initial of a word in their label, then any free letter or digit in it.
 * Keys depend only on the labels, so a menu keeps them until its items change.
 */
export function assignMenuLetters(
  items: readonly { label: string; fixed?: string | undefined }[],
  reserved = "",
) {
  const taken = new Set([
    ...reserved,
    ...items.flatMap(({ fixed }) => (fixed ? [fixed.toLowerCase()] : [])),
  ]);
  return items.map(({ label, fixed }) => {
    if (fixed) return fixed;
    const text = label.toLowerCase();
    const initials = (text.match(/[\p{L}\p{N}]+/gu) ?? []).map(
      (word) => word[0] as string,
    );
    const letters = text.match(/[a-z0-9]/g) ?? [];
    const letter = [...initials, ...letters].find(
      (candidate) => /^[a-z0-9]$/.test(candidate) && !taken.has(candidate),
    );
    if (letter) taken.add(letter);
    return letter;
  });
}

const ITEM = ".buzz-menu-item";

/** This popup's own items; a submenu's popup labels its own. */
function itemsOf(popup: HTMLElement) {
  return [...popup.querySelectorAll<HTMLElement>(ITEM)].filter(
    (item) => item.closest(".buzz-menu-popup") === popup,
  );
}

/** The item's own words, not trailing counts or hints that change. */
function labelOf(item: HTMLElement) {
  const copy = item.cloneNode(true) as HTMLElement;
  for (const extra of copy.querySelectorAll(
    ".buzz-menu-trailing, .buzz-menu-item-indicator",
  ))
    extra.remove();
  return copy.textContent ?? "";
}

function label(popup: HTMLElement) {
  const items = itemsOf(popup);
  const letters = assignMenuLetters(
    items.map((item) => ({
      label: labelOf(item),
      fixed: item.dataset.menuLetterFixed,
    })),
    reservedKeys(),
  );
  items.forEach((item, index) => {
    const letter = letters[index];
    if (letter === undefined) {
      delete item.dataset.menuLetter;
      item.removeAttribute("aria-keyshortcuts");
    } else if (item.dataset.menuLetter !== letter) {
      item.dataset.menuLetter = letter;
      item.setAttribute("aria-keyshortcuts", letter);
    }
  });
}

function unlabel(popup: HTMLElement) {
  for (const item of itemsOf(popup)) {
    delete item.dataset.menuLetter;
    item.removeAttribute("aria-keyshortcuts");
  }
}

/** The popup's letters: its ref labels items, its key handler runs them. */
export function useMenuLetters() {
  const on = useSyncExternalStore(subscribe, lettersOn, lettersOn);
  const stop = useRef<() => void>(undefined);
  const ref = useCallback<RefCallback<HTMLDivElement>>(
    (popup) => {
      stop.current?.();
      stop.current = undefined;
      if (!popup || !on) return;
      label(popup);
      // Items can render after the popup, or change while it is open.
      const observer = new MutationObserver(() => label(popup));
      observer.observe(popup, {
        childList: true,
        subtree: true,
        characterData: true,
      });
      stop.current = () => {
        observer.disconnect();
        unlabel(popup);
      };
    },
    [on],
  );
  // Before Base UI's typeahead, which listens on the popup as the key bubbles.
  const onKeyDownCapture = (event: KeyboardEvent<HTMLDivElement>) => {
    if (
      !on ||
      // A submenu's popup sits in this one's React tree; it handles its keys.
      (event.target as Element).closest?.(".buzz-menu-popup") !==
        event.currentTarget ||
      event.defaultPrevented ||
      event.metaKey ||
      event.ctrlKey ||
      event.altKey ||
      event.key.length !== 1 ||
      // A field inside the menu keeps its typing.
      (event.target as Element).closest?.(
        'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]',
      )
    )
      return;
    const key = event.key.toLowerCase();
    const item = itemsOf(event.currentTarget).find(
      (candidate) => candidate.dataset.menuLetter?.toLowerCase() === key,
    );
    if (!item) return;
    event.preventDefault();
    event.stopPropagation();
    if (item.hasAttribute("data-disabled")) return;
    // Highlight it first, as arrowing to it would; Base UI acts on that item.
    item.focus();
    item.click();
  };
  return { ref, onKeyDownCapture };
}
