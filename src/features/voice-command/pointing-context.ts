const excluded =
  'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [data-voice-command], [aria-hidden="true"], [inert], .sr-only';
const targets =
  '[data-message-id], [data-channel-id], [data-solo-channel-id], button, a, [role="button"], [role="tab"], [role="menuitem"], h1, h2, h3, p, li, img';

/** Capture the visible object, never raw DOM, editor values, or an entire page. */
export function pointedTarget(target: Element | null) {
  if (!target || target.closest(excluded)) return;
  const element =
    target.closest("[data-message-id]") ?? target.closest(targets);
  if (!(element instanceof HTMLElement) || element.closest(excluded)) return;
  return element;
}
