import styles from "./Messages.module.css";

const cues = new WeakMap<HTMLElement, () => void>();

/** The same temporary orientation cue for a revealed message and a return. */
export function highlightMessage(row: HTMLElement, signal?: AbortSignal) {
  const previous = cues.get(row);
  if (previous) {
    previous();
    // Commit the removed class so this request starts a fresh animation.
    row.getBoundingClientRect();
  }
  const clear = () => {
    if (cues.get(row) !== clear) return;
    cues.delete(row);
    row.classList.remove(styles.returnHighlight ?? "");
    row.removeEventListener("animationend", finish);
    signal?.removeEventListener("abort", clear);
  };
  const finish = (event: AnimationEvent) => {
    if (event.target === row && event.pseudoElement === "::after") clear();
  };
  cues.set(row, clear);
  row.classList.add(styles.returnHighlight ?? "");
  row.addEventListener("animationend", finish);
  signal?.addEventListener("abort", clear, { once: true });
  return clear;
}
