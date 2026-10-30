import styles from "./Messages.module.css";

/** The same temporary orientation cue for a revealed message and a return. */
export function highlightMessage(row: HTMLElement, signal?: AbortSignal) {
  const clear = () => {
    row.classList.remove(styles.returnHighlight ?? "");
    row.removeEventListener("animationend", finish);
    signal?.removeEventListener("abort", clear);
  };
  const finish = (event: AnimationEvent) => {
    if (event.target === row && event.pseudoElement === "::after") clear();
  };
  row.classList.add(styles.returnHighlight ?? "");
  row.addEventListener("animationend", finish);
  signal?.addEventListener("abort", clear, { once: true });
  return clear;
}
