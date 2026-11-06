import type { ReactNode } from "react";
import styles from "./HideMuted.module.css";

/** Host muted rows stay quiet; this shows why a hidden one came back. */
export function AttentionMark({
  active,
  children,
}: {
  active: boolean;
  children: ReactNode;
}) {
  return (
    <div className={styles.mark}>
      {children}
      {active && (
        <span
          className={styles.dot}
          data-hide-muted-attention=""
          aria-hidden="true"
        />
      )}
    </div>
  );
}
