import styles from "./Messages.module.css";

/** Briefly wash a message so the reader can find where they arrived. Paints the
 * message itself, never its day divider. Returns a clear for an early retire. */
export function highlightMessage(item: HTMLElement): () => void {
  const row = item.querySelector<HTMLElement>(":scope > [data-layout]");
  if (!row) return () => {};
  const clear = () => {
    row.classList.remove(styles.messageHighlight ?? "");
    row.removeEventListener("animationend", finish);
  };
  const finish = (event: AnimationEvent) => {
    if (event.target === row && event.pseudoElement === "::after") clear();
  };
  // Restart the cue when the same message is reached again.
  clear();
  void row.offsetWidth;
  row.classList.add(styles.messageHighlight ?? "");
  row.addEventListener("animationend", finish);
  return clear;
}
