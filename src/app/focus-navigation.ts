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
  return !front || front === element.closest(COVERING);
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

/** Land on the selected tab so existing arrow-key tab navigation remains usable. */
export function paneFocusTarget() {
  const targets = workspaces()
    .map(
      (pane) =>
        pane.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]') ??
        composerIn(pane),
    )
    .filter((target): target is HTMLElement => !!target && available(target));
  const index = targets.findIndex(
    (target) => target.closest(WORKSPACE) === focusedWorkspace(),
  );
  return targets[(index + 1) % targets.length];
}
