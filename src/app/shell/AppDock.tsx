import type { ComponentProps, ReactNode } from "react";
import { PageNavigation } from "./PageNavigation";
import { SidebarNavigation } from "../../shared/design-system/ui/SidebarNavigation";
import { NavigationSection } from "../../shared/design-system/ui/NavigationSection";
import styles from "./AppDock.module.css";
import { useScrollEdges } from "../../shared/design-system/ui/useScrollEdges";
import sectionStyles from "./RailArrangement.module.css";

export function AppDock({
  search,
  community,
  profile,
  settings,
  children,
  header,
  showPrimaryNavigation = true,
  open = true,
  compact = false,
  onDismiss,
  ...pages
}: Omit<ComponentProps<typeof PageNavigation>, "placement"> & {
  search: ReactNode;
  community: ReactNode;
  profile: ReactNode;
  settings: ReactNode;
  children?: ReactNode;
  header?: ReactNode;
  showPrimaryNavigation?: boolean;
  open?: boolean;
  compact?: boolean;
  onDismiss?: () => void;
}) {
  const scrollEdges = useScrollEdges("block");
  return (
    <nav
      className={styles.frame}
      aria-label="Apps"
      id="shell-rail"
      data-open={open || undefined}
      inert={!open}
      aria-hidden={!open}
      data-compact={compact || undefined}
      onKeyDown={(event) => {
        if (
          event.key === "Escape" &&
          !event.shiftKey &&
          !event.defaultPrevented &&
          // The list column is portaled from here; its keys are not the rail's.
          event.target instanceof Node &&
          event.currentTarget.contains(event.target) &&
          !(
            event.target instanceof Element &&
            event.target.closest(
              '[role="menu"], [role="dialog"], [data-context-menu-present], [aria-haspopup="menu"][aria-expanded="true"]',
            )
          )
        ) {
          event.preventDefault();
          onDismiss?.();
        }
      }}
      data-search-external={!search || undefined}
    >
      {header && (
        <div
          className={`${sectionStyles.group} ${styles.heading} ${compact ? "buzz-dock-controls" : ""}`}
        >
          {header}
        </div>
      )}
      <div
        className={styles.apps}
        ref={scrollEdges}
        data-scroll-fade="scrolled"
      >
        <SidebarNavigation>
          {showPrimaryNavigation && (
            <div className={`${sectionStyles.group} ${styles.primary}`}>
              <NavigationSection>
                {search}
                <PageNavigation
                  {...pages}
                  placement={compact ? "dock" : "sidebar"}
                />
              </NavigationSection>
            </div>
          )}
          {children}
        </SidebarNavigation>
      </div>
      <div id="rail-drop-slot" className={styles.dropSlot} />
      {(community || profile || settings) && (
        <div className={styles.footer}>
          {community}
          {profile}
          {settings}
        </div>
      )}
    </nav>
  );
}
