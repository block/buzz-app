import { useLayoutEffect, useRef, useState } from "react";
import { readView, writeView } from "../../shared/view-state";

type SidebarView = { search: string; collapsed: string[]; scrollTop: number };

function restore(scope: string): SidebarView {
  const raw = readView<unknown>(scope, "channel-sidebar", null);
  const saved =
    raw && typeof raw === "object" ? (raw as Partial<SidebarView>) : {};
  return {
    search: typeof saved.search === "string" ? saved.search : "",
    collapsed: Array.isArray(saved.collapsed)
      ? saved.collapsed.filter((key): key is string => typeof key === "string")
      : [],
    scrollTop:
      typeof saved.scrollTop === "number" &&
      Number.isFinite(saved.scrollTop) &&
      saved.scrollTop >= 0
        ? saved.scrollTop
        : 0,
  };
}

/** Scoped to the ready community/viewer workspace; no roster or message cache. */
export function useSidebarView(scope: string, ready: boolean) {
  const [view, setView] = useState(() => restore(scope));
  const intent = useRef(view);
  const list = useRef<HTMLElement>(null);
  const pending = useRef(true);

  // Once the viewport moves, the user owns it even if they return to the top.
  useLayoutEffect(() => {
    const viewport = list.current;
    if (!viewport) return;
    const scrolled = () => {
      pending.current = false;
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

  const update = (next: SidebarView) => {
    intent.current = next;
    setView(next);
  };
  return {
    list,
    search: view.search,
    collapsed: view.collapsed,
    setSearch: (search: string) => {
      pending.current = false;
      update({ ...intent.current, search });
    },
    toggle: (key: string, open: boolean) => {
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
  };
}
