import { sequenceStep, type Sequence } from "./sequences";

/** The keys typed so far, and whether the which-key menu shows them. */
export type PendingSnapshot =
  | Readonly<{ typed: string; shown: boolean }>
  | undefined;

/** Neovim's `timeoutlen` in the owner's config: show the menu after a pause. */
export const SHOW_AFTER_MS = 300;
/** Marks the which-key menu, whose own clicks and keys belong to the sequence. */
export const WHICH_KEY = "data-vim-which-key";
const MODIFIER = /^(Shift|Control|Alt|Meta|CapsLock|Fn|AltGraph)$/;

/**
 * Reads the keys after a sequence's first key. While pending it takes every
 * printable key, so a partial sequence never types or triggers anything else.
 * Escape, a click elsewhere or a modified key cancels; the modified key then
 * still does its own job.
 */
export function createPending(
  sequences: () => readonly Sequence[],
  showAfter: (typed: string) => number,
) {
  let snapshot: PendingSnapshot;
  let origin: HTMLElement | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const listeners = new Set<() => void>();
  const set = (next: PendingSnapshot) => {
    snapshot = next;
    for (const listener of listeners) listener();
  };
  const inMenu = (node: EventTarget | null) =>
    node instanceof Element && !!node.closest(`[${WHICH_KEY}]`);

  const onKey = (event: KeyboardEvent) => {
    if (MODIFIER.test(event.key) || event.isComposing) return;
    // Holding the first key must not complete a sequence such as gg; held
    // arrows still move through the menu.
    if (event.repeat && event.key.length === 1) {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    if (event.metaKey || event.ctrlKey || event.altKey) return cancel();
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopImmediatePropagation();
      return cancel();
    }
    // Arrows, Enter and Tab drive the menu while it shows; otherwise cancel.
    if (event.key.length !== 1) {
      if (!snapshot?.shown) cancel();
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    press(event.key);
  };
  const onPointer = (event: PointerEvent) => {
    if (!inMenu(event.target)) cancel();
  };
  const listen = (on: boolean) => {
    if (on) {
      window.addEventListener("keydown", onKey, true);
      window.addEventListener("pointerdown", onPointer, true);
      window.addEventListener("blur", cancel);
    } else {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("pointerdown", onPointer, true);
      window.removeEventListener("blur", cancel);
    }
  };
  const schedule = (typed: string) => {
    clearTimeout(timer);
    const delay = showAfter(typed);
    if (delay <= 0) return set({ typed, shown: true });
    set({ typed, shown: false });
    timer = setTimeout(() => {
      if (snapshot?.typed === typed) set({ typed, shown: true });
    }, delay);
  };

  function cancel() {
    if (!snapshot) return;
    clearTimeout(timer);
    listen(false);
    set(undefined);
  }
  function start(prefix: string) {
    cancel();
    const active = document.activeElement;
    origin =
      active instanceof HTMLElement && active !== document.body
        ? active
        : undefined;
    listen(true);
    schedule(prefix);
  }
  function press(key: string) {
    if (!snapshot) return;
    const typed = snapshot.typed + key;
    const step = sequenceStep(typed, sequences());
    if (step.kind === "more") {
      if (snapshot.shown) set({ typed, shown: true });
      else schedule(typed);
      return;
    }
    cancel();
    if (step.kind !== "run") return;
    // Act where the sequence began, not on the menu that showed it.
    if (
      origin?.isConnected &&
      (inMenu(document.activeElement) ||
        document.activeElement === document.body)
    )
      origin.focus({ preventScroll: true });
    step.sequence.run();
  }

  return {
    start,
    press,
    cancel,
    snapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
export type Pending = ReturnType<typeof createPending>;
