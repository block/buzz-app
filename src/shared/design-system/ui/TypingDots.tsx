import styles from "./TypingDots.module.css";

/** Shared channel typing motion. Callers own live-state evidence and labelling. */
export function TypingDots() {
  return (
    <span className={styles.dots} aria-hidden="true">
      <span />
      <span />
      <span />
    </span>
  );
}
