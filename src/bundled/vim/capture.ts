/*
 * The few keys Vim keys must take before the app's own handlers do: a menu's
 * keys as it opens, Tab and Escape on a message, and Escape in a field. Every
 * other key is a registered shortcut (see index.tsx).
 */
import { host } from "./host";
import {
  focused,
  inMenu,
  openMenu,
  POPUP_LIST,
  press,
  ROW,
  selectField,
  SHEET,
  SIDEBAR,
  SUBVIEW,
  typing,
  WHICH_KEY,
} from "./dom";
import { bottom, leave, sideways, step, stepPart } from "./motion";
import type { Pending } from "./pending";

/** A key's action, when the rule takes it. */
type Rule = (
  event: KeyboardEvent,
  origin: HTMLElement | undefined,
) => (() => void) | undefined;

const plainEscape = (event: KeyboardEvent) =>
  event.key === "Escape" && !event.shiftKey && !event.isComposing;

export function captureKeys({
  pending,
  markRead,
}: {
  pending: Pending;
  /** Escape on a conversation's message still marks it read. */
  markRead(): void;
}) {
  /** j, k, h, l, gg and G in a menu or choice list. */
  const menuMoves: Record<string, () => void> = {
    j: () => step(true),
    k: () => step(false),
    h: () => sideways(false),
    l: () => sideways(true),
    g: () => pending.start("g"),
    G: bottom,
  };
  const free = () => !pending.snapshot() && !typing();

  const rules: Rule[] = [
    // A just-opened menu owns its keys before focus reaches it, so an item's
    // key typed at once (go, then r) runs that item.
    (event, origin) => {
      const opening = openMenu();
      if (
        !opening ||
        event.key.length !== 1 ||
        !free() ||
        opening.contains(origin ?? null)
      )
        return;
      return () => {
        opening.focus();
        const move = menuMoves[event.key];
        if (move) move();
        else press(opening, event.key);
      };
    },
    // A menu's typeahead stops keys it does not use, so moves start here.
    (event, origin) =>
      free() && origin?.closest(POPUP_LIST) && !origin.closest(`[${WHICH_KEY}]`)
        ? menuMoves[event.key]
        : undefined,
    // Escape in a field of a dialog or the sidebar selects it rather than
    // leaving, as Vim's Escape ends insert mode, unless the field's own list
    // or completions has Escape.
    (event, origin) =>
      plainEscape(event) &&
      origin &&
      typing() &&
      origin.closest(`[aria-modal="true"], [role="dialog"], ${SIDEBAR}`) &&
      !origin.closest(
        '[data-composer-surface], [role="combobox"], [aria-expanded="true"], .xterm',
      )
        ? () => selectField(origin)
        : undefined,
    // Escape leaves a thread's message box, whose tab or sheet closes on
    // Escape, unless a suggestion list or an edit has it; and leaves the
    // sidebar before marking the conversation read takes it.
    (event, origin) => {
      if (!plainEscape(event) || !origin) return;
      const leaves = origin.matches("[data-tab-focus]")
        ? !!origin.closest(`:is(${SUBVIEW}) [data-composer-surface]`) &&
          !origin.hasAttribute("aria-controls") &&
          !origin.closest("[data-editing]")
        : !!origin.closest(SIDEBAR) && !typing() && !inMenu();
      return leaves ? leave : undefined;
    },
    // Tab steps through a message's parts; Escape on one goes back to its
    // message, and on the message closes its sheet or marks it read. A menu
    // the message opened owns Escape, even before it takes focus.
    (event, origin) => {
      const row = origin?.closest<HTMLElement>(ROW);
      if (!origin || !row || event.target !== origin || typing()) return;
      if (!host.messages.listOf(row)) return;
      if (event.key === "Tab") return () => stepPart(!event.shiftKey);
      if (
        event.key !== "Escape" ||
        inMenu() ||
        origin.hasAttribute("data-menu-origin")
      )
        return;
      if (origin !== host.messages.focusTarget(row)) return leave;
      const sheet = origin.closest<HTMLElement>(SHEET);
      if (!sheet) return markRead;
      // A tip or card over the sheet closes first.
      const over = document.querySelector<HTMLElement>(
        `[role="dialog"][data-open]:not(${SHEET})`,
      );
      if (over) return () => press(over, "Escape");
      return () => press(sheet, "Escape");
    },
  ];

  const keydown = (event: KeyboardEvent) => {
    if (
      event.defaultPrevented ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey
    )
      return;
    const origin = focused();
    for (const rule of rules) {
      const run = rule(event, origin);
      if (!run) continue;
      event.preventDefault();
      event.stopPropagation();
      run();
      return;
    }
  };
  // Escape in a field leaves it for the selected message before any shortcut
  // on Escape, such as marking the conversation read, takes it; the field's
  // own Escape (closing a suggestion list) still comes first.
  const fieldEscape = (event: KeyboardEvent) => {
    if (
      event.defaultPrevented ||
      !plainEscape(event) ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey ||
      !typing() ||
      focused()?.closest('.xterm, [aria-modal="true"], dialog[open]')
    )
      return;
    event.preventDefault();
    leave();
  };
  addEventListener("keydown", keydown, true);
  document.addEventListener("keydown", fieldEscape);
  return () => {
    removeEventListener("keydown", keydown, true);
    document.removeEventListener("keydown", fieldEscape);
  };
}
