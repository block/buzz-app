import { SidebarNavigation } from "../../shared/design-system/ui/SidebarNavigation";
import type { ReactNode } from "react";
import { Panel } from "../../shared/design-system/ui/Panel";
import styles from "./SidebarFrame.module.css";

/** Shared sidebar surface; callers own its contents, data and scroll behavior. */
export function SidebarFrame({
  label,
  busy,
  launchPending,
  children,
  header,
  footer,
  panelId,
  cards = false,
}: {
  label: string;
  header?: ReactNode;
  /** Floats over the list's end and follows it in tab order. */
  footer?: ReactNode;
  panelId?: string | undefined;
  busy?: boolean | undefined;
  launchPending?: "required" | "settling" | undefined;
  children?: ReactNode;
  /** The sidebar sits on the window's tint and each section is its own card. */
  cards?: boolean;
}) {
  const surface = {
    "aria-label": label,
    "aria-busy": busy,
    "data-buzz-launch-pending": launchPending,
  };
  const content = (
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
      {footer}
    </div>
  );
  return cards ? (
    <aside {...surface} data-sidebar-cards="" className={styles.cards}>
      {content}
    </aside>
  ) : (
    <Panel as="aside" {...surface}>
      {content}
    </Panel>
  );
}
