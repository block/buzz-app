import { useCallback, useState, type ReactNode } from "react";
import { ToastProvider } from "../../shared/design-system/ui/Toast";
import styles from "./Messages.module.css";

/** Foreground actions belong to the viewer; background notices keep their host. */
export function MediaViewerToasts({ children }: { children: ReactNode }) {
  // Create the portal target before rendering, then attach it in the same commit.
  // Both media layout effects and mount-time feedback need their owners immediately.
  const [container] = useState(() => document.createElement("div"));
  const attach = useCallback(
    (host: HTMLDivElement | null) => {
      host?.appendChild(container);
    },
    [container],
  );
  return (
    <ToastProvider portalContainer={container}>
      <div ref={attach} className={styles.mediaViewerToastHost} />
      {children}
    </ToastProvider>
  );
}
