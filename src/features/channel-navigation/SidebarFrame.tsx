import { SidebarToolbar } from "./SidebarToolbar";
import { SidebarNavigation } from "../../shared/design-system/ui/SidebarNavigation";
import type { ReactNode } from "react";
import { Panel } from "../../shared/design-system/ui/Panel";
import styles from "../../bundled/channels/Channels.module.css";

/** Shared sidebar surface; callers own its contents, data and scroll behavior. */
export function SidebarFrame({
  label,
  busy,
  launchPending,
  children,
  header,
  paneHeader,
  panelId,
}: {
  label: string;
  header?: ReactNode;
  paneHeader?: ReactNode;
  panelId?: string | undefined;
  busy?: boolean | undefined;
  launchPending?: "required" | "settling" | undefined;
  children?: ReactNode;
}) {
  return (
    <Panel
      as="aside"
      aria-label={label}
      aria-busy={busy}
      data-buzz-launch-pending={launchPending}
    >
      <div className={styles.sidebarFrame}>
        <SidebarToolbar />
        {paneHeader}
        <div className={styles.sidebar}>
          <SidebarNavigation>
            {header && <div className={styles.sidebarFilter}>{header}</div>}
            <div
              className={styles.sidebarBody}
              id={panelId}
              {...(panelId
                ? { role: "tabpanel", "aria-labelledby": `${panelId}-tab` }
                : {})}
            >
              {children}
            </div>
          </SidebarNavigation>
        </div>
      </div>
    </Panel>
  );
}
