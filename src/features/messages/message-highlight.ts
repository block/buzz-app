import styles from "./Messages.module.css";

/** The part of a `[data-message-id]` item the arrival cue paints: the message
 * itself, never its day divider. Each row type marks its own surface. */
export function messageHighlightSurface(item: HTMLElement): HTMLElement | null {
  return item.matches("[data-highlight-surface]")
    ? item
    : item.querySelector<HTMLElement>(":scope > [data-highlight-surface]");
}

/** Briefly mark a message so the reader can find where they arrived. The cue
 * paints on the surface itself or, when it has a filled bubble, on that
 * bubble. Returns a clear for an early retire. */
export function highlightMessage(item: HTMLElement): () => void {
  const surface = messageHighlightSurface(item);
  if (!surface) return () => {};
  const clear = () => {
    surface.classList.remove(styles.messageHighlight ?? "");
    surface.removeEventListener("animationend", finish);
  };
  const finish = (event: AnimationEvent) => {
    const target = event.target as Element;
    if (
      event.pseudoElement === "::after" &&
      (target === surface ||
        target.classList.contains(styles.messageBubble ?? ""))
    )
      clear();
  };
  // Restart the cue when the same message is reached again.
  clear();
  void surface.offsetWidth;
  surface.classList.add(styles.messageHighlight ?? "");
  surface.addEventListener("animationend", finish);
  return clear;
}
