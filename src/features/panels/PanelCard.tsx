import { X } from "lucide-react";
import type { PanelProps, RegisteredPanel } from "./service";
import { PanelView } from "./PanelView";
import styles from "./Panels.module.css";

// Ordinary shared UI: the caller still owns placement and selection.
export function PanelCard({
  panel,
  closeLabel,
  ...props
}: PanelProps & {
  panel: RegisteredPanel;
  closeLabel?: string;
}) {
  return (
    <aside className={styles.card} aria-label={panel.title}>
      <header className={styles.heading}>
        <strong>{panel.title}</strong>
        <button
          type="button"
          aria-label={closeLabel ?? `Close ${panel.title} panel`}
          onClick={props.close}
        >
          <X size={18} aria-hidden="true" />
        </button>
      </header>
      <div className={styles.content}>
        <PanelView panel={panel} {...props} />
      </div>
    </aside>
  );
}
