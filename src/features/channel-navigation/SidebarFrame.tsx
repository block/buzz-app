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
  panelId,
  layout = "navigation",
}: {
  label: string;
  layout?: "navigation" | "collection";
  header?: ReactNode;
  panelId?: string | undefined;
  busy?: boolean | undefined;
  launchPending?: "required" | "settling" | undefined;
  children?: ReactNode;
}) {
  const contents = (
    <>
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
    </>
  );
  return (
    <Panel
      as="aside"
      aria-label={label}
      aria-busy={busy}
      data-buzz-launch-pending={launchPending}
    >
      <div
        className={`${styles.sidebar} ${layout === "collection" ? styles.collectionSidebar : ""}`}
      >
        {layout === "collection" ? (
          contents
        ) : (
          <SidebarNavigation>{contents}</SidebarNavigation>
        )}
      </div>
    </Panel>
  );
}
