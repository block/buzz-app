import { useCallback, useMemo, useSyncExternalStore } from "react";
import {
  readView,
  subscribeView,
  viewRevision,
  writeView,
} from "../../shared/view-state";
import { parseRailEntries, type RailEntry } from "./rail-pins";

type Placement = { section: string; entry: RailEntry };
export type RailLayout = {
  order: string[];
  sections: { id: string; title: string }[];
  placements: Placement[];
};
export const LAYOUT_KEY = "navigation-layout:v2";
const KEY = LAYOUT_KEY;

const readLayout = (scope: string) =>
  parseRailLayout(readView<unknown>(scope, KEY, null));
/** Team's section was once named for its page; saved arrangements still say so. */
const sectionId = (id: string) => (id === "messages" ? "team" : id);
export function parseRailLayout(value: unknown): RailLayout {
  const raw = value as Partial<RailLayout> | null;
  const sections = Array.isArray(raw?.sections)
    ? raw.sections.filter(
        (section) =>
          typeof section?.id === "string" &&
          section.id.startsWith("custom:") &&
          typeof section.title === "string" &&
          !!section.title.trim(),
      )
    : [];
  const placements: Placement[] = [];
  if (Array.isArray(raw?.placements))
    for (const item of raw.placements) {
      const entry = parseRailEntries([item?.entry])[0];
      if (!entry || typeof item?.section !== "string") continue;
      const section = sectionId(item.section);
      // An app row has one place; a conversation has one copy per section.
      if (
        !placements.some(
          (placed) =>
            placed.entry.id === entry.id &&
            (entry.kind === "page" || placed.section === section),
        )
      )
        placements.push({ section, entry });
    }
  const order = Array.isArray(raw?.order)
    ? [
        ...new Set(
          raw.order.filter((id) => typeof id === "string").map(sectionId),
        ),
      ]
    : [];
  return { order, sections, placements };
}

/** The rail's arrangement never writes to a conversation or plugin's data.
 * This device's copy answers at once; `syncRail` shares it with the account. */
export function useRailLayout(scope: string) {
  const subscribe = useCallback(
    (listener: () => void) => subscribeView(scope, listener),
    [scope],
  );
  const revision = useSyncExternalStore(
    subscribe,
    () => viewRevision(scope, KEY),
    () => undefined,
  );
  const layout = useMemo(
    () =>
      revision !== undefined
        ? readLayout(scope)
        : { order: [], sections: [], placements: [] },
    [scope, revision],
  );
  const save = (update: (current: RailLayout) => RailLayout) =>
    writeView(scope, KEY, update(readLayout(scope)));
  /** Other placements of an entry that survive placing it in a section. */
  const others = (
    current: RailLayout,
    entry: RailEntry,
    section: string,
    from?: string,
  ) =>
    current.placements.filter(
      (item) =>
        item.entry.id !== entry.id ||
        (entry.kind !== "page" &&
          item.section !== section &&
          item.section !== from),
    );
  /** Places an entry in a section, leaving `from` when it moves from there. */
  const move = (entry: RailEntry, section: string, from?: string) =>
    save((current) => ({
      ...current,
      placements: [
        ...others(current, entry, section, from),
        { section, entry },
      ],
    }));
  /** Moves a section to another's place. `shown` are the sections in the
   * order the rail shows them. A saved section that isn't shown now, like a
   * plugin's that is starting or disabled, keeps its place. */
  const reorder = (id: string, over: string, shown: string[]) =>
    save((current) => {
      const order = [
        ...current.order,
        ...shown.filter((key) => !current.order.includes(key)),
      ];
      const from = order.indexOf(id);
      const to = order.indexOf(over);
      if (from < 0 || to < 0) return current;
      order.splice(from, 1);
      order.splice(to, 0, id);
      return { ...current, order };
    });
  /** A new section follows every placed one: it has no saved position yet. */
  const create = (
    id: string,
    title: string,
    entry?: RailEntry,
    from?: string,
  ) =>
    save((current) => ({
      ...current,
      sections: [...current.sections, { id: `custom:${id}`, title }],
      placements: entry
        ? [
            ...others(current, entry, `custom:${id}`, from),
            { section: `custom:${id}`, entry },
          ]
        : current.placements,
    }));
  const rename = (id: string, title: string) =>
    save((current) => ({
      ...current,
      sections: current.sections.map((section) =>
        section.id === id ? { ...section, title } : section,
      ),
    }));
  /** Takes an entry out of one section, or out of every one. */
  const reset = (entryId: string, section?: string) =>
    save((current) => ({
      ...current,
      placements: current.placements.filter(
        (item) =>
          item.entry.id !== entryId ||
          (section !== undefined && item.section !== section),
      ),
    }));
  const remove = (id: string) =>
    save((current) => ({
      ...current,
      order: current.order.filter((key) => key !== id),
      sections: current.sections.filter((section) => section.id !== id),
      placements: current.placements.filter((item) => item.section !== id),
    }));
  return {
    layout,
    move,
    reorder,
    create,
    rename,
    remove,
    reset,
  };
}
