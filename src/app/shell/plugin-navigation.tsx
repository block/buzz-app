import { useCallback, useMemo, useSyncExternalStore } from "react";
import type { RegisteredPage } from "../../features/pages/service";
import type { PluginManager } from "../../plugins/manager";
import { AllPlugins } from "./AllPlugins";
import type { AllPluginsEntry } from "./all-plugins";
import { PageIcon } from "./PageIcon";
import {
  type PluginPinSort,
  savePluginPinSort,
  savePluginPins,
  useSavedPluginPinSort,
  useSavedPluginPins,
} from "./plugin-pins";
import {
  orderPages,
  pagePlacement,
  pagePresentation,
  resolvePluginPins,
  sortPinsByLabel,
} from "./presentation";

/** The Plugins card's pins and its All plugins row, which lists every plugin
 * that is on and has a page. */
export function usePluginNavigation({
  plugins,
  pages,
  selected,
  onSelect,
}: {
  plugins: PluginManager;
  pages: readonly RegisteredPage[];
  selected: string;
  onSelect: (key: string) => void;
}) {
  const { configuration } = useSyncExternalStore(
    plugins.subscribe,
    plugins.snapshot,
  );
  const catalog =
    configuration.status === "ready"
      ? configuration.catalog.plugins
      : undefined;
  const saved = useSavedPluginPins();
  const sort = useSavedPluginPinSort();

  const sidebarPages = useMemo(
    () => orderPages(pages.filter((page) => pagePlacement(page) === "sidebar")),
    [pages],
  );
  const pins = useMemo(() => {
    const builtIn = catalog
      ? new Set(
          catalog
            .filter((plugin) => plugin.source === "bundled")
            .map((plugin) => plugin.manifest.id),
        )
      : undefined;
    const resolved = resolvePluginPins(
      saved,
      sidebarPages,
      builtIn && ((id) => builtIn.has(id)),
    );
    return resolved && sort === "alphabetical"
      ? sortPinsByLabel(resolved, sidebarPages)
      : resolved;
  }, [catalog, saved, sort, sidebarPages]);

  const entries = useMemo((): readonly AllPluginsEntry[] => {
    const pinned = new Map((pins ?? []).map((id, index) => [id, index]));
    // One entry per plugin: its first page in navigation order.
    const first = new Map<string, RegisteredPage>();
    for (const page of sidebarPages)
      if (!first.has(page.pluginId)) first.set(page.pluginId, page);
    return [...first.values()]
      .map((page) => {
        const { label, icon, image } = pagePresentation(page);
        return {
          key: page.pluginId,
          label,
          icon: (
            <PageIcon icon={icon} image={image} size={16} strokeWidth={2.5} />
          ),
          pinned: pinned.has(page.pluginId),
          active: page.key === selected,
        };
      })
      .sort(
        (a, b) =>
          (pinned.get(a.key) ?? Number.POSITIVE_INFINITY) -
          (pinned.get(b.key) ?? Number.POSITIVE_INFINITY),
      );
  }, [pins, sidebarPages, selected]);

  const pin = useCallback(
    (id: string, on: boolean) => {
      const current = pins ?? [];
      savePluginPins(
        on
          ? [...current.filter((pinned) => pinned !== id), id]
          : current.filter((pinned) => pinned !== id),
      );
    },
    [pins],
  );
  const reorder = useCallback(
    (ids: readonly string[]) => {
      // The popover reorders the pins it shows; pins of plugins that are off
      // or not installed here keep their places after them.
      const shown = new Set(ids);
      savePluginPins([...ids, ...(pins ?? []).filter((id) => !shown.has(id))]);
      savePluginPinSort("custom");
    },
    [pins],
  );
  const changeSort = useCallback(
    (next: PluginPinSort) => {
      // Custom starts from the order on screen, so switching changes nothing
      // until a pin moves.
      if (next === "custom" && pins) savePluginPins(pins);
      savePluginPinSort(next);
    },
    [pins],
  );
  const open = useCallback(
    (id: string) => {
      const page = sidebarPages.find((page) => page.pluginId === id);
      if (page) onSelect(page.key);
    },
    [sidebarPages, onSelect],
  );
  const allPlugins = useMemo(
    () =>
      pins ? (
        <AllPlugins
          plugins={entries}
          onOpen={open}
          onPinnedChange={pin}
          onPinnedOrderChange={reorder}
          sort={sort}
          onSortChange={changeSort}
        />
      ) : undefined,
    [pins, entries, open, pin, reorder, sort, changeSort],
  );
  return { pins, allPlugins };
}
