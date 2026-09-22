import type React from "react";
import { useEffect, useId, useRef, useState, type ReactElement } from "react";
import { createPortal } from "react-dom";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { NavigationItem } from "../../shared/design-system/ui/NavigationItem";
import {
  type GhostSpec,
  type WindowHost,
  type WindowLayout,
  MAIN_WINDOW,
  windowTitle,
} from "../../features/windows/service";

/** Move targets for one tab: never the window it is already in. */
export function moveTargets(
  layout: WindowLayout,
  label: string,
  tabsHere: number,
): readonly { destination: string; title: string }[] {
  const targets: { destination: string; title: string }[] = [];
  // A tab alone in a detached window already has its own window.
  if (label === MAIN_WINDOW || tabsHere > 1)
    targets.push({ destination: "new", title: "Move to new window" });
  if (label !== MAIN_WINDOW)
    targets.push({ destination: MAIN_WINDOW, title: "Move to main window" });
  for (const window of layout.windows)
    if (window.label !== label)
      targets.push({
        destination: window.label,
        title: `Move to ${windowTitle(layout, window.label)}`,
      });
  return targets;
}

type Point = { x: number; y: number };
type Rect = { left: number; top: number; right: number; bottom: number };

/**
 * A release inside this window's own header is a cancelled drag (tabs are not
 * reordered yet); anywhere else, including outside the window, is a drop.
 */
export function releasedInStrip(
  point: Point,
  header: Rect | undefined,
  viewport: { width: number; height: number },
): boolean {
  if (!header) return false;
  if (
    point.x < 0 ||
    point.y < 0 ||
    point.x >= viewport.width ||
    point.y >= viewport.height
  )
    return false;
  return (
    point.x >= header.left &&
    point.x < header.right &&
    point.y >= header.top &&
    point.y < header.bottom
  );
}

/** The selected page pill: the opaque surface every lifted tab borrows. */
const SELECTED_TAB = '.navigation-item[data-variant="pill"][data-selected]';

/**
 * What the native pill needs to look exactly like `tab`: its size, its icon
 * markup and the resolved styles of a selected tab, read from the live DOM so
 * the ghost follows the theme without mirroring tokens. Launchers lift as an
 * icon-only disc.
 */
export function ghostSpec(
  tab: HTMLElement,
  title: string,
  rect: { width: number; height: number },
  launcher = false,
): GhostSpec {
  const own = getComputedStyle(tab);
  // Unselected tabs are transparent and launchers are translucent glass that
  // relies on a backdrop the floating pill does not have; both lift with the
  // opaque selected-tab surface.
  const selected = translucent(own.backgroundColor)
    ? tab.ownerDocument.querySelector<HTMLElement>(SELECTED_TAB)
    : undefined;
  const icon = tab.querySelector<SVGElement | HTMLImageElement>("svg, img");
  return {
    title: launcher ? "" : title,
    ...(icon
      ? { icon: icon.outerHTML, iconSize: getComputedStyle(icon).width }
      : {}),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
    background: selected
      ? getComputedStyle(selected).backgroundColor
      : own.backgroundColor,
    color: own.color,
    font: own.font,
    padding: own.padding,
    gap: own.gap,
    radius: own.borderRadius,
    shadow: own.boxShadow,
  };
}

/** Whether a computed CSS color has any transparency (`transparent`, rgba/color alpha < 1). */
export function translucent(color: string): boolean {
  if (color === "transparent" || color === "") return true;
  // Alpha is the 4th comma component (rgba/hsla) or follows a slash (color()/modern syntax).
  const alpha =
    /\/\s*([\d.]+%?)\s*\)$/.exec(color) ??
    /^[a-z]+\((?:[^,()]+,){3}\s*([\d.]+%?)\s*\)$/i.exec(color);
  const raw = alpha?.[1];
  if (raw === undefined) return false;
  const value = raw.endsWith("%")
    ? Number(raw.slice(0, -1)) / 100
    : Number(raw);
  return value < 1;
}

/**
 * A tab (page pill) or launcher (round icon button for a panel) with a
 * browser-like context menu for moving it between windows. `tabKey` is the
 * layout key: a page contribution key or `panel:<contribution key>`.
 */
export function PageTab({
  tabKey,
  name,
  icon,
  launcher = false,
  selected,
  onSelect,
  windows,
  layout,
  tabsHere,
  detachable,
  expanded,
}: {
  tabKey: string;
  /** Tab label; the launcher's accessible name and the native drag ghost's title. */
  name: string;
  icon: ReactElement;
  /** Render as a launcher disc instead of a page pill. */
  launcher?: boolean;
  selected: boolean;
  onSelect(event: React.MouseEvent<HTMLButtonElement>): void;
  windows: WindowHost;
  layout: WindowLayout;
  tabsHere: number;
  /** Whether moving between windows is available (desktop with the plugin on). */
  detachable: boolean;
  expanded?: boolean;
}) {
  // Anchored below the tab but rendered in a portal: the tab strip scrolls
  // horizontally, which would otherwise clip anything hanging below it.
  const [anchor, setAnchor] = useState<{ top: number; left: number }>();
  const [error, setError] = useState<string>();
  const menu = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();
  const open = !!anchor;
  const setOpen = (next: boolean) => {
    if (!next) return setAnchor(undefined);
    const rect = trigger.current?.getBoundingClientRect();
    if (rect) setAnchor({ top: rect.bottom + 8, left: rect.left });
  };
  const targets =
    detachable && windows.moveTab
      ? moveTargets(layout, windows.label, tabsHere)
      : [];
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: Event) => {
      const target = event.target as Node;
      if (!menu.current?.contains(target) && !trigger.current?.contains(target))
        setAnchor(undefined);
    };
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setAnchor(undefined);
      trigger.current?.focus();
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("focusin", dismiss);
    document.addEventListener("keydown", onEscape);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("focusin", dismiss);
      document.removeEventListener("keydown", onEscape);
    };
  }, [open]);
  const report = (reason: unknown) =>
    setError(reason instanceof Error ? reason.message : String(reason));
  const move = async (destination: string) => {
    setOpen(false);
    setError(undefined);
    try {
      await windows.moveTab?.(tabKey, destination);
    } catch (reason) {
      report(reason);
    }
  };
  // Browser-style tab dragging with pointer events: HTML drag-and-drop cannot
  // leave a webview, but macOS keeps delivering pointer moves and the release
  // to the window where the press began, so Rust can resolve the drop point and
  // move the native ghost that stays visible beyond this window's edge.
  const drag = useRef<{
    x: number;
    y: number;
    active: boolean;
    /** Pointer offset inside the tab, so the pill moves as the tab itself. */
    grab: { x: number; y: number };
  }>(undefined);
  const dragged = useRef(false);
  // While lifted the tab's slot stays but the tab itself is the native pill.
  const [lifted, setLifted] = useState(false);
  const endDrag = () => {
    if (drag.current?.active) windows.drag?.end();
    drag.current = undefined;
    setLifted(false);
  };
  const lift = (event: React.PointerEvent<HTMLButtonElement>) => {
    const tab = event.currentTarget;
    const rect = tab.getBoundingClientRect();
    const grab = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    // Client-to-screen translation at this instant, whatever the window chrome.
    const dx = event.screenX - event.clientX;
    const dy = event.screenY - event.clientY;
    windows.drag?.begin(
      tabKey,
      ghostSpec(tab, name, rect, launcher),
      rect.left + dx,
      rect.top + dy,
    );
    setLifted(true);
    return grab;
  };
  const control = {
    ref: trigger,
    "aria-expanded": expanded,
    "aria-haspopup": targets.length ? ("menu" as const) : undefined,
    "aria-controls": open ? id : undefined,
    "data-lifted": lifted || undefined,
    // Native drag-and-drop of any child (images, selected text) would take
    // the gesture away from the pointer-based tab drag.
    onDragStart: (event: React.DragEvent) => event.preventDefault(),
    onClick: (event: React.MouseEvent<HTMLButtonElement>) => {
      if (dragged.current) {
        dragged.current = false;
        return;
      }
      onSelect(event);
    },
    onContextMenu: (event: React.MouseEvent<HTMLButtonElement>) => {
      if (!targets.length) return;
      event.preventDefault();
      event.currentTarget.focus();
      setOpen(true);
    },
    onPointerDown: (event: React.PointerEvent<HTMLButtonElement>) => {
      if (!detachable || !windows.dropTab || event.button !== 0) return;
      drag.current = {
        x: event.clientX,
        y: event.clientY,
        active: false,
        grab: { x: 0, y: 0 },
      };
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    onPointerMove: (event: React.PointerEvent<HTMLButtonElement>) => {
      const state = drag.current;
      if (!state) return;
      if (!state.active) {
        if (Math.hypot(event.clientX - state.x, event.clientY - state.y) < 6)
          return;
        state.active = true;
        setAnchor(undefined);
        state.grab = lift(event);
      } else
        windows.drag?.move(
          event.screenX - state.grab.x,
          event.screenY - state.grab.y,
        );
    },
    onPointerUp: (event: React.PointerEvent<HTMLButtonElement>) => {
      const state = drag.current;
      // The drop command hides the ghost itself; only a cancel needs an explicit end.
      if (state?.active) drag.current = undefined;
      else endDrag();
      if (!state?.active) return;
      // The click that follows this release is the drag's, not a selection.
      dragged.current = true;
      setTimeout(() => {
        dragged.current = false;
      }, 0);
      const header = event.currentTarget
        .closest("header")
        ?.getBoundingClientRect();
      if (
        releasedInStrip({ x: event.clientX, y: event.clientY }, header, {
          width: window.innerWidth,
          height: window.innerHeight,
        })
      ) {
        windows.drag?.end();
        setLifted(false);
        return;
      }
      setError(undefined);
      // A successful drop unmounts this tab here; only failure puts it back.
      windows
        .dropTab?.(tabKey, event.screenX, event.screenY)
        .catch((reason) => {
          windows.drag?.end();
          setLifted(false);
          report(reason);
        });
    },
    onPointerCancel: endDrag,
  };
  return (
    <>
      {launcher ? (
        <IconButton
          {...control}
          type="button"
          variant="chrome"
          shape="round"
          aria-label={name}
          title={name}
          icon={icon}
        />
      ) : (
        <NavigationItem
          {...control}
          type="button"
          variant="pill"
          aria-current={selected ? "page" : undefined}
          selected={selected}
          label={name}
          icon={icon}
        />
      )}
      {targets.length > 0 &&
        anchor &&
        createPortal(
          <div
            ref={menu}
            id={id}
            role="menu"
            aria-label="Move to another window"
            style={{ position: "fixed", top: anchor.top, left: anchor.left }}
            className="z-50 w-56 rounded-2xl border border-line bg-surface p-2 shadow-surface"
          >
            {targets.map((target) => (
              <button
                type="button"
                role="menuitem"
                key={target.destination}
                className="flex w-full items-center border-0 px-3 py-2 text-left text-label-sm hover:bg-soft"
                onClick={() => void move(target.destination)}
              >
                {target.title}
              </button>
            ))}
          </div>,
          document.body,
        )}
      {error &&
        createPortal(
          <p
            role="alert"
            className="error fixed top-16 left-1/2 z-50 -translate-x-1/2 rounded-xl border border-line bg-surface px-3 py-2 text-caption shadow-surface"
          >
            {error}
          </p>,
          document.body,
        )}
    </>
  );
}
