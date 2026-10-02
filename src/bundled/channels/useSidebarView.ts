import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { readView, writeView } from "../../shared/view-state";

export const CHANNEL_SIDEBAR_DEFAULT_WIDTH = 260;
export const CHANNEL_SIDEBAR_MIN_WIDTH = 220;
export const CHANNEL_SIDEBAR_MAX_WIDTH = 520;

export function clampChannelSidebarWidth(width: number) {
  return Math.min(
    CHANNEL_SIDEBAR_MAX_WIDTH,
    Math.max(CHANNEL_SIDEBAR_MIN_WIDTH, Math.round(width)),
  );
}

type SidebarView = {
  collapsed: string[];
  scrollTop: number;
  width: number;
  /** The destination whose sidebar entry the saved position shows. */
  location?: string | undefined;
};

// Preserve explicit resize intent across route remounts when storage is unavailable.
const widths = new Map<string, number>();

function restore(scope: string): SidebarView {
  const raw = readView<unknown>(scope, "channel-sidebar", null);
  const saved =
    raw && typeof raw === "object" ? (raw as Partial<SidebarView>) : {};
  return {
    collapsed: Array.isArray(saved.collapsed)
      ? saved.collapsed.filter((key): key is string => typeof key === "string")
      : [],
    scrollTop:
      typeof saved.scrollTop === "number" &&
      Number.isFinite(saved.scrollTop) &&
      saved.scrollTop >= 0
        ? saved.scrollTop
        : 0,
    width:
      widths.get(scope) ??
      (typeof saved.width === "number" && Number.isFinite(saved.width)
        ? clampChannelSidebarWidth(saved.width)
        : CHANNEL_SIDEBAR_DEFAULT_WIDTH),
    location: typeof saved.location === "string" ? saved.location : undefined,
  };
}

/** Scoped to the ready community/viewer workspace; no roster or message cache. */
export function readChannelSidebarWidth(scope: string): number {
  return restore(scope).width;
}

/**
 * Show the current destination (`aria-current="page"`) in the sidebar
 * viewport. Rows hidden by a collapsed section or session list are shown
 * through the header or parent row that represents them. Returns false while
 * no current entry is laid out yet.
 */
function revealCurrent(viewport: HTMLElement) {
  const owners = [
    ...viewport.querySelectorAll<HTMLElement>('[aria-current="page"]'),
  ].map((entry) => {
    let owner = entry;
    for (let node: HTMLElement | null = entry; node && node !== viewport; ) {
      if (node.hidden && node.previousElementSibling instanceof HTMLElement)
        owner = node.previousElementSibling;
      node = node.parentElement;
    }
    return owner.getBoundingClientRect();
  });
  const rects = owners.filter((rect) => rect.height);
  const rect = rects[0];
  if (!rect) return false;
  const top = viewport.getBoundingClientRect().top;
  const bottom = top + viewport.clientHeight;
  // A visible copy (for example, a starred channel) already shows it.
  if (rects.some((rect) => rect.top >= top && rect.bottom <= bottom))
    return true;
  // Center an offscreen entry clear of the unread edge cues; nudge a clipped
  // one only as far as needed so the row under the pointer does not jump.
  viewport.scrollTop +=
    rect.bottom <= top || rect.top >= bottom
      ? rect.top - top - (viewport.clientHeight - rect.height) / 2
      : rect.top < top
        ? rect.top - top
        : rect.bottom - bottom;
  return true;
}

/**
 * `location` keys the main pane's destination. A new destination reveals its
 * sidebar entry once, when that entry first renders, unless the user scrolls
 * first. Remounting at the saved destination keeps the saved position.
 */
export function useSidebarView(
  scope: string,
  ready: boolean,
  location?: string,
) {
  const [view, setView] = useState(() => restore(scope));
  const intent = useRef(view);
  const list = useRef<HTMLElement>(null);
  const pending = useRef(true);
  // The destination waiting for its entry to render.
  const reveal = useRef<string | undefined>(undefined);
  // Until the first reveal or scroll, the saved destination keeps the
  // restored position.
  const restored = useRef(view.location);

  // Once the viewport moves, the user owns it even if they return to the top.
  useLayoutEffect(() => {
    const viewport = list.current;
    if (!viewport) return;
    const scrolled = () => {
      pending.current = false;
      reveal.current = restored.current = undefined;
    };
    viewport.addEventListener("scroll", scrolled, { passive: true });
    return () => viewport.removeEventListener("scroll", scrolled);
  }, []);

  // Wait for roster/group layout, not optional profile enrichment or messages.
  useLayoutEffect(() => {
    if (!ready || !pending.current || !list.current) return;
    // Compositor scrolling may update the position before its scroll event.
    if (list.current.scrollTop === 0)
      list.current.scrollTop = intent.current.scrollTop;
    pending.current = false;
  }, [ready]);
  // A destination without an entry (the Messages landing page before it
  // resolves to a conversation) stays pending and is never saved.
  useLayoutEffect(() => {
    reveal.current = location === restored.current ? undefined : location;
  }, [location]);
  // The entry can render after navigation (roster startup, a new DM), so
  // retry after each commit until it exists. Runs after the restore above.
  useLayoutEffect(() => {
    if (!ready || !reveal.current || !list.current) return;
    if (!revealCurrent(list.current)) return;
    intent.current = { ...intent.current, location: reveal.current };
    reveal.current = restored.current = undefined;
  });
  useLayoutEffect(() => {
    const save = () => {
      if (!pending.current && list.current)
        intent.current = {
          ...intent.current,
          scrollTop: list.current.scrollTop,
        };
      writeView(scope, "channel-sidebar", intent.current);
    };
    window.addEventListener("pagehide", save);
    return () => {
      save();
      window.removeEventListener("pagehide", save);
    };
  }, [scope]);

  const update = useCallback((next: SidebarView) => {
    intent.current = next;
    setView(next);
  }, []);
  const toggle = useCallback(
    (key: string, open: boolean) => {
      const collapsed = intent.current.collapsed;
      if (collapsed.includes(key) === !open) return;
      pending.current = false;
      update({
        ...intent.current,
        collapsed: open
          ? collapsed.filter((id) => id !== key)
          : [...collapsed, key],
      });
    },
    [update],
  );
  return {
    list,
    collapsed: view.collapsed,
    width: view.width,
    toggle,
    setWidth: (width: number) => {
      const next = clampChannelSidebarWidth(width);
      if (intent.current.width === next) return;
      widths.set(scope, next);
      update({ ...intent.current, width: next });
      writeView(scope, "channel-sidebar", { ...intent.current, width: next });
    },
  };
}
