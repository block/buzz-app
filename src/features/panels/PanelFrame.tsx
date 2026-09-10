import type { ReactNode } from "react";
import styles from "./Panels.module.css";

// Keep this frame mounted even while closed: changing ancestry resets page state.
export function PanelFrame({
  companion,
  children,
}: {
  companion?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className={`${styles.frame} ${companion ? styles.withCompanion : ""}`}>
      <div className={styles.page}>{children}</div>
      {companion && <div className={styles.dock}>{companion}</div>}
    </div>
  );
}
