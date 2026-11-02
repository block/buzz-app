import styles from "./IdentitySetup.module.css";

/** Mobile's centered bee-and-heading treatment, keeping the live step label. */
export function SetupProgress({ label }: { label: string }) {
  return (
    <div className={styles.progress}>
      <span className={styles.loadingBee} aria-hidden="true" />
      <h1
        id="welcome-title"
        tabIndex={-1}
        className="text-heading text-standard"
      >
        Setting up Buzz
      </h1>
      <p role="status" className="text-body text-subtle">
        {label}
      </p>
    </div>
  );
}
