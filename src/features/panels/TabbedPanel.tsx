import {
  useCallback,
  useEffect,
  useRef,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { Panel } from "../../shared/design-system/ui/Panel";
import { Tabs } from "../../shared/design-system/ui/Tabs";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { XIcon } from "../../shared/design-system/icons/index";

export type PanelTab = {
  value: string;
  label: string;
  content: ReactNode;
  close(): void;
};

/**
 * The page owns tab lifetimes; switching retains each view's DOM and geometry.
 *
 * Two closes, because a person has two intentions. Each tab's own control
 * dismisses that one view and leaves the rest open; the trailing control closes
 * the panel, which is what its position in the corner has always promised.
 * Escape means the second, since it addresses the surface a person is in rather
 * than a single tab within it.
 */
export function TabbedPanel({
  tabs,
  value,
  onValueChange,
  onClose,
}: {
  tabs: readonly PanelTab[];
  value: string;
  onValueChange(value: string): void;
  onClose(): void;
}) {
  const selected = tabs.find((tab) => tab.value === value) ?? tabs[0];
  const root = useRef<HTMLDivElement>(null);
  /**
   * Read at focus time rather than captured, because the tab that survives a
   * dismissal is only known after the page commits the shorter list — and when
   * the closed tab was the selected one, `value` still names it while `selected`
   * has already fallen back.
   */
  const surviving = useRef<string | undefined>(undefined);
  surviving.current = selected?.value;
  const focusSelectedTab = useCallback(() => {
    if (!surviving.current) return;
    root.current
      ?.querySelector<HTMLElement>(`[data-tab-value="${surviving.current}"]`)
      ?.focus();
  }, []);
  // Opening moves focus into the panel, at the view a person asked for rather
  // than at the control that would close it again.
  useEffect(focusSelectedTab, [focusSelectedTab]);
  /**
   * Dismissing one tab while another remains must leave a person inside the
   * panel. Each tab's `close` restores focus to whatever originally opened that
   * view, which is right when the panel is going away and wrong when it is not —
   * it would eject a person from a surface they are still using.
   *
   * A passive effect, not a layout effect: the page owning these tabs restores
   * its own trigger focus in a layout effect, and every child layout effect runs
   * *before* its parent's. Reclaiming focus here is the only ordering that
   * actually lands after the page has had its say. If the last tab closes this
   * component unmounts, so the page's restoration correctly stands.
   *
   * Keyed on the closing tab's own value rather than a flag, because a dismissal
   * that changes the route renders at least once with the tab still listed. A
   * flag would be spent on that intermediate render and focus would never be
   * reclaimed; waiting for the value to leave the list waits for the dismissal
   * to have actually happened.
   */
  const closing = useRef<string | undefined>(undefined);
  useEffect(() => {
    const pending = closing.current;
    if (!pending) return;
    if (tabs.some((tab) => tab.value === pending)) return;
    closing.current = undefined;
    focusSelectedTab();
  });
  if (!selected) return null;
  return (
    <Panel
      as="div"
      ref={root}
      onKeyDown={(event: KeyboardEvent) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <Tabs
        label="Panel tabs"
        variant="pill"
        value={selected.value}
        items={tabs.map((tab) => ({
          value: tab.value,
          label: tab.label,
          dismiss: {
            label: `Close ${tab.label} tab`,
            onDismiss: () => {
              closing.current = tabs.length > 1 ? tab.value : undefined;
              tab.close();
            },
          },
        }))}
        onValueChange={onValueChange}
        retainPanels
        renderPanel={(key) => tabs.find((tab) => tab.value === key)?.content}
        trailingAction={
          <IconButton
            size="toolbar"
            aria-label="Close panel"
            onClick={onClose}
            icon={<XIcon size={18} aria-hidden="true" />}
          />
        }
      />
    </Panel>
  );
}
