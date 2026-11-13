import { focusWithKeyboard } from "../shared/design-system/useKeyboardFocusVisibility";

const PRIMARY = "[data-main-workspace], [data-solo-focus-pane]";
const WORKSPACE = `${PRIMARY}, [data-panel-workspace]`;
const COVERING = `${WORKSPACE}, [data-panel-dock]`;

function available(element: HTMLElement) {
  if (
    element.closest('[hidden], [inert], [aria-hidden="true"]') ||
    !element.getClientRects().length
  )
    return false;
  const bounds = element.getBoundingClientRect();
  const front = document
    .elementsFromPoint(
      bounds.x + bounds.width / 2,
      bounds.y + bounds.height / 2,
    )
    .find((hit) => hit.closest(COVERING))
    ?.closest(COVERING);
  // Skip notifications, but include dock content without its own workspace.
  return front === element.closest(COVERING);
}

function workspaces() {
  return Array.from(
    document
      .getElementById("main-content")
      ?.querySelectorAll<HTMLElement>(WORKSPACE) ?? [],
  );
}

function focusedWorkspace() {
  return document.activeElement?.closest<HTMLElement>(WORKSPACE);
}

/** A tool tab without a composer must never redirect typing to another pane. */
export function composerFocusTarget() {
  const main = document.getElementById("main-content");
  return composerIn(
    focusedWorkspace() ?? main?.querySelector<HTMLElement>(PRIMARY) ?? main,
  );
}

function composerIn(root: HTMLElement | null | undefined) {
  return Array.from(
    root?.querySelectorAll<HTMLElement>(
      '[data-tab-focus]:is([role="textbox"], input, textarea)',
    ) ?? [],
  ).find(
    (element) =>
      available(element) &&
      !element.matches(
        '[aria-disabled="true"], [disabled], [readonly], [contenteditable="false"]',
      ),
  );
}

/** Search selects a conversation in main, regardless of its previous focus. */
export function conversationFocusTarget(channelId: string) {
  const conversation = document
    .getElementById("main-content")
    ?.querySelector(`[data-channel-workspace="${CSS.escape(channelId)}"]`);
  const main = conversation?.querySelector<HTMLElement>(PRIMARY);
  return (
    composerIn(main) ??
    [
      ...(main?.querySelectorAll<HTMLElement>("[data-message-scroller]") ?? []),
      ...(main?.querySelectorAll<HTMLElement>("[data-channel-history]") ?? []),
    ].find(available)
  );
}

export function focusKeyboardTarget(target: HTMLElement | undefined) {
  if (!target) return;
  focusWithKeyboard(target);
}

/** Resume typing in a conversation; tool panes fall back to their selected tab. */
export function paneFocusTarget(pane?: "main" | "side") {
  const targets = workspaces()
    .filter(
      (workspace) =>
        !pane ||
        workspace.matches(pane === "main" ? PRIMARY : "[data-panel-workspace]"),
    )
    .map(
      (pane) =>
        composerIn(pane) ??
        pane.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]'),
    )
    .filter((target): target is HTMLElement => !!target && available(target));
  if (pane) return targets[0];
  const index = targets.findIndex(
    (target) => target.closest(WORKSPACE) === focusedWorkspace(),
  );
  return targets[(index + 1) % targets.length];
}

// Places a click keeps for itself: editing, embedded apps, terminals, overlays,
// find, stateful controls and tab strips (tab selection focuses its content).
const OWNS_CLICK = [
  "input",
  "textarea",
  "select",
  '[contenteditable]:not([contenteditable="false"])',
  "iframe",
  ".xterm",
  "dialog",
  '[role="dialog"]',
  '[role="alertdialog"]',
  '[role="menu"]',
  '[role="listbox"]',
  '[role="tablist"]',
  "search",
  '[role="search"]',
  '[role="slider"]',
  '[role="switch"]',
  '[role="checkbox"]',
  '[role="radiogroup"]',
  "[data-open][data-side]",
  '[aria-haspopup]:not([aria-haspopup="false"])[aria-expanded="true"]',
].join(", ");

// A modal open now; one still mounted for its closing motion has let focus go.
const OPEN_MODAL = '[aria-modal="true"]:not([data-closed])';

// Open layers a click outside dismisses; their own close returns focus. A layer
// still mounted for its closing motion has already returned it.
const DISMISSIBLE =
  '[aria-modal="true"]:not([data-closed]), [role="menu"]:not([data-closed]), [role="listbox"]:not([data-closed]), [data-open][data-side]';

// Containers a click focuses only as a side effect: a message row (selectable
// by keyboard), its history scroller, or the pane itself.
const PASSIVE = `[data-message-id], [data-message-id] > [data-layout], [data-message-scroller], [data-channel-history], ${COVERING}, #main-content`;

/** Focus a click left on no control, or on a container it only passed through. */
function passiveFocus(active: Element | null) {
  return (
    !active ||
    active === document.body ||
    active === document.documentElement ||
    (active.matches(PASSIVE) && !active.closest(OWNS_CLICK))
  );
}

/**
 * A click anywhere that does not take focus for itself resumes typing in the
 * clicked pane's message box (a thread tab's own, say), or from shared chrome
 * the last focused pane's. Panes without a message box keep their focus.
 */
export function installComposerClickFocus() {
  let origin: HTMLElement | null | undefined;
  let touch = false;
  let dismissing = false;
  let frame: number | undefined;
  const down = (event: PointerEvent) => {
    origin = focusedWorkspace();
    // A finger or pen tap must not raise an on-screen keyboard.
    touch = event.pointerType === "touch" || event.pointerType === "pen";
    dismissing = !!document.querySelector(DISMISSIBLE);
  };
  const click = (event: MouseEvent) => {
    if (
      touch ||
      dismissing ||
      // Keyboard activation (detail 0) keeps keyboard focus where it is.
      event.detail === 0 ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    )
      return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    const pane = target.closest<HTMLElement>(COVERING);
    const from = origin;
    if (frame !== undefined) cancelAnimationFrame(frame);
    // Let the click's own work (opening a popover, choosing a tab) land first.
    frame = requestAnimationFrame(() => {
      frame = undefined;
      const selection = document.getSelection();
      if (
        !target.isConnected ||
        target.closest(OWNS_CLICK) ||
        // A click that opened a modal (a media review, say) leaves focus to it,
        // even before the modal's own focus effect has run.
        document.querySelector(OPEN_MODAL) ||
        (selection && !selection.isCollapsed) ||
        !passiveFocus(document.activeElement)
      )
        return;
      const main = document.getElementById("main-content");
      const composer = pane
        ? composerIn(pane)
        : (composerIn(from) ??
          composerIn(main?.querySelector<HTMLElement>(PRIMARY) ?? main));
      composer?.focus({ preventScroll: true });
    });
  };
  window.addEventListener("pointerdown", down, true);
  window.addEventListener("click", click);
  return () => {
    window.removeEventListener("pointerdown", down, true);
    window.removeEventListener("click", click);
    if (frame !== undefined) cancelAnimationFrame(frame);
  };
}
