import { Tabs as BaseTabs } from "@base-ui/react/tabs";
import { useEffect, useRef, type ReactNode } from "react";
import { XIcon } from "../icons/index";

export type TabItem<Value extends string> = {
  value: Value;
  label: string;
  icon?: ReactNode;
  /**
   * Dismisses this view, drawn as its own control beside the label.
   *
   * A sibling of the tab rather than a child of it: a button inside a button is
   * invalid, and a screen reader would announce one control where there are two.
   * Its own `label` because "Close" alone is ambiguous once several are present.
   */
  dismiss?: { label: string; onDismiss(): void };
};

/**
 * Which background this control is drawn for.
 *
 * `chrome` is the glass pill that belongs on the app gradient. `panel` is an
 * underline for a plain light or dark surface. `pill` is a contained pill on a
 * plain surface, for views a person opened and can dismiss one at a time.
 *
 * **A variant rather than a second component**, because behaviour, keyboard
 * model, accessibility, props, and the Base UI tabs underneath are identical —
 * only the appearance differs, which is what a variant is for. `IconButton`
 * spells the same idea the same way.
 *
 * `chrome` is the default because every existing call site is on the gradient.
 */
export type TabsVariant = "chrome" | "panel" | "workspace" | "pill";

export function Tabs<Value extends string>({
  value,
  items,
  label,
  onValueChange,
  trailingAction,
  variant = "chrome",
  previewValue,
  arrivalValue,
  renderPanel,
  retainPanels = false,
}: {
  /** Keep full-height panel views mounted and laid out while inactive. */
  retainPanels?: boolean;
  /** Omit only when composing an existing externally owned view. */
  renderPanel?: (value: Value) => ReactNode;
  value: Value;
  items: readonly TabItem<Value>[];
  label: string;
  onValueChange: (value: Value) => void;
  trailingAction?: ReactNode;
  variant?: TabsVariant;
  /** Incoming tab being previewed before a workspace drop is committed. */
  previewValue?: Value;
  /** Brief visual confirmation of a tab arriving after a completed move. */
  arrivalValue?: Value | undefined;
}) {
  const list = useRef<HTMLDivElement>(null);
  /**
   * A strip narrower than its tabs scrolls, and the selected tab is the one a
   * person is reading — so it has to be the one on screen. The browser only
   * does this for the *focused* element, which leaves the selected tab
   * off-screen whenever selection changed without focus or the column simply
   * got narrower: at 390px a selected agent tab sat entirely outside the strip
   * with nothing to say it existed.
   *
   * Scrolls the strip itself rather than calling `scrollIntoView`, which also
   * scrolls every ancestor that can move and would drag the panel around a tab.
   * The pill — label and close control together — is what gets revealed, so a
   * tab never arrives with its own dismissal hanging off the edge.
   */
  useEffect(() => {
    const strip = list.current;
    if (!strip) return;
    const reveal = () => {
      const tab = [
        ...strip.querySelectorAll<HTMLElement>("[data-tab-value]"),
      ].find((element) => element.dataset.tabValue === value);
      const pill = tab?.closest<HTMLElement>(".buzz-tabs-item") ?? tab;
      if (!pill) return;
      const inset = strip.getBoundingClientRect();
      const box = pill.getBoundingClientRect();
      // The same inset the stylesheet reserves for keyboard scrolling, so a
      // revealed pill sits inside the strip rather than flush against its edge.
      const room = Number.parseFloat(
        getComputedStyle(strip).scrollPaddingInlineStart,
      );
      const edge = Number.isFinite(room) ? room : 0;
      const past = box.right - (inset.right - edge);
      const before = inset.left + edge - box.left;
      if (past > 0) strip.scrollLeft += past;
      else if (before > 0) strip.scrollLeft -= before;
    };
    reveal();
    /* Two observers, because two different things move the selected tab out of
       view and neither implies the other. A narrower column resizes the strip
       while its tabs are unchanged; opening or closing a tab leaves the strip
       exactly the same size and moves everything inside it. The same pairing
       the sidebar's fading label uses, for the same reason. */
    const mutations = new MutationObserver(reveal);
    mutations.observe(strip, {
      characterData: true,
      childList: true,
      subtree: true,
    });
    const observer =
      typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver(reveal);
    observer?.observe(strip);
    return () => {
      mutations.disconnect();
      observer?.disconnect();
    };
  }, [value]);
  const strip = (
    <>
      <BaseTabs.List ref={list} className="buzz-tabs-list" aria-label={label}>
        <BaseTabs.Indicator className="buzz-tabs-indicator" />
        {items.map((item) => {
          const tab = (
            <BaseTabs.Tab
              key={item.value}
              value={item.value}
              className="buzz-tabs-tab"
              /* Base UI spells the selected tab `data-active`; every other
               selectable thing in this codebase is styled on `data-selected`.
               Restating it here keeps one spelling in the stylesheet rather than
               asking a reader to know which components happen to be Base
               UI-backed. Without it the selected label silently kept
               `--text-secondary` — no error, just a tab that never looked
               selected. */
              data-selected={item.value === value || undefined}
              data-preview={item.value === previewValue || undefined}
              data-tab-value={item.value}
            >
              {variant === "workspace" && item.value === arrivalValue ? (
                <span className="buzz-tabs-arrival" aria-hidden="true" />
              ) : null}
              {item.icon}
              <span>{item.label}</span>
            </BaseTabs.Tab>
          );
          /* Only a dismissible tab gains a wrapper. A tab without one renders
             exactly the markup it did before, so the four existing call sites
             keep their measured layout and the indicator keeps its geometry. */
          return item.dismiss ? (
            <span key={item.value} className="buzz-tabs-item">
              {tab}
              <button
                type="button"
                className="buzz-tabs-dismiss"
                aria-label={item.dismiss.label}
                onClick={item.dismiss.onDismiss}
              >
                <XIcon size={14} aria-hidden="true" />
              </button>
            </span>
          ) : (
            tab
          );
        })}
      </BaseTabs.List>
      {trailingAction}
    </>
  );
  return (
    <BaseTabs.Root
      data-buzz-ui=""
      className={renderPanel ? "buzz-tab-panels" : "buzz-tabs"}
      data-variant={variant}
      data-retain-panels={retainPanels || undefined}
      value={value}
      onValueChange={(nextValue) => onValueChange(nextValue as Value)}
    >
      {renderPanel ? (
        <div className="buzz-tabs" data-variant={variant}>
          {strip}
        </div>
      ) : (
        strip
      )}
      {renderPanel &&
        items.map((item) => (
          <BaseTabs.Panel
            key={item.value}
            value={item.value}
            className="buzz-tabs-panel"
            keepMounted={retainPanels}
            {...(retainPanels
              ? {
                  hidden: false,
                  inert: item.value !== value,
                  "aria-hidden": item.value !== value,
                }
              : {})}
          >
            {renderPanel(item.value)}
          </BaseTabs.Panel>
        ))}
    </BaseTabs.Root>
  );
}
