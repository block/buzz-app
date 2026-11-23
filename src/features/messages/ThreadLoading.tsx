import styles from "./Messages.module.css";

/** The thread's placeholder; a tab also shows it while its conversation resolves. */
export function ThreadLoading({
  label = "Loading thread…",
}: {
  label?: string;
}) {
  return (
    <div className={styles.threadLoading} role="status">
      <picture>
        <source
          media="(prefers-reduced-motion: reduce)"
          srcSet="/buzz-mark.svg"
        />
        <img src="/buzz-loading-mark.svg" alt="" width="498" height="341" />
      </picture>
      <span className="sr-only">{label}</span>
    </div>
  );
}
