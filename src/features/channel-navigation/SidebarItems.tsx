import { useSidebarRowInset } from "./sidebar-presentation";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { NavigationItem } from "../../shared/design-system/ui/NavigationItem";
import { CaretUpIcon, DotsThreeIcon } from "../../shared/design-system/icons";
import { sidebarPage, SIDEBAR_PAGE_SIZE } from "./sidebar-page";
import styles from "./SidebarItems.module.css";

/** Presentation only: inventories retain their ordering, access, and actions. */
export function SidebarItems<T extends { id: string }>({
  items,
  label,
  selectedId,
  revealId,
  children,
  uncapped = false,
  expandAll = false,
}: {
  items: readonly T[];
  label: string;
  uncapped?: boolean;
  expandAll?: boolean;
  selectedId?: string | undefined;
  revealId?: string | undefined;
  children(item: T): ReactNode;
}) {
  const rowInset = useSidebarRowInset();
  const [extra, setExtra] = useState(0);
  if (extra > 0 && items.length <= SIDEBAR_PAGE_SIZE) setExtra(0);
  const [retained, setRetained] = useState<string>();
  // Moving a row into a full section must leave its focus destination visible.
  if (
    revealId &&
    revealId !== retained &&
    items.some((item) => item.id === revealId)
  )
    setRetained(revealId);
  const root = useRef<HTMLDivElement>(null);
  const actions = useRef<HTMLDivElement>(null);
  const restoreFocus = useRef(false);
  useLayoutEffect(() => {
    if (!restoreFocus.current) return;
    restoreFocus.current = false;
    const target =
      actions.current?.querySelector<HTMLButtonElement>("button") ??
      [
        ...(root.current?.querySelectorAll<HTMLButtonElement>("button") ?? []),
      ].at(-1);
    target?.focus({ preventScroll: true });
  });
  const listed = uncapped
    ? [...items]
    : sidebarPage(items, SIDEBAR_PAGE_SIZE + extra, [selectedId, retained]);
  const more = listed.length < items.length;
  return (
    <div ref={root}>
      {listed.map((item) => (
        <div key={item.id}>{children(item)}</div>
      ))}
      {!uncapped && (more || extra > 0) && (
        <div
          ref={actions}
          className={styles.actions}
          data-inset={rowInset || undefined}
        >
          {more && (
            <NavigationItem
              variant="row"
              label="More"
              aria-label={`More in ${label}`}
              icon={<DotsThreeIcon size={16} aria-hidden="true" />}
              onClick={() => {
                restoreFocus.current = true;
                setExtra(
                  expandAll
                    ? Number.POSITIVE_INFINITY
                    : extra + SIDEBAR_PAGE_SIZE,
                );
              }}
            />
          )}
          {extra > 0 && (
            <NavigationItem
              variant="row"
              label="Less"
              icon={<CaretUpIcon size={16} aria-hidden="true" />}
              aria-label={`Fewer in ${label}`}
              onClick={() => {
                restoreFocus.current = true;
                setRetained(undefined);
                setExtra(0);
              }}
            />
          )}
        </div>
      )}
    </div>
  );
}
