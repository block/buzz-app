import styles from "./Messages.module.css";

const cues = new WeakMap<HTMLElement, () => void>();

/** Revealed links keep their cue until dismissal; returns briefly orient the reader. */
export function highlightMessage(
  row: HTMLElement,
  signal?: AbortSignal,
  mode: "return" | "linked" = "return",
) {
  const owner = row.ownerDocument;
  const linked = mode === "linked";
  const style = linked ? styles.linkedHighlight : styles.returnHighlight;
  const previous = cues.get(row);
  if (previous) {
    previous();
    // Commit the removed class so this request starts a fresh animation.
    row.getBoundingClientRect();
  }
  const clear = () => {
    if (cues.get(row) !== clear) return;
    cues.delete(row);
    row.classList.remove(style ?? "");
    row.removeEventListener("animationend", finish);
    owner.removeEventListener("click", dismiss, true);
    owner.removeEventListener("keydown", dismiss, true);
    signal?.removeEventListener("abort", clear);
  };
  const finish = (event: AnimationEvent) => {
    if (event.target === row && event.pseudoElement === "::after") clear();
  };
  const dismiss = (event: Event) => {
    if (
      event.type === "keydown"
        ? (event as KeyboardEvent).key === "Escape"
        : event.target instanceof Node && !row.contains(event.target)
    )
      clear();
  };
  cues.set(row, clear);
  row.classList.add(style ?? "");
  if (linked) {
    owner.addEventListener("click", dismiss, true);
    owner.addEventListener("keydown", dismiss, true);
  } else row.addEventListener("animationend", finish);
  signal?.addEventListener("abort", clear, { once: true });
  return clear;
}
