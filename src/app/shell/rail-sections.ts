import type { RailLayout } from "./rail-layout";
import type { RailEntry } from "./rail-pins";

export type RailSection = { id: string; title: string };
const builtins: readonly RailSection[] = [
  { id: "navigation", title: "Plugins" },
  { id: "pins", title: "Pins" },
  { id: "messages", title: "Team" },
  { id: "solo", title: "Solo" },
  { id: "agents", title: "Agents" },
];

/** A conversation's own list, and where apps live: nothing is copied here. */
const homes = new Set(["navigation", "messages", "solo", "agents"]);
/**
 * Whether a section holds its own copy of this entry. A conversation always
 * stays in Team or Solo, so a section a person made, like Pins, lists it as
 * well. An app's row has no such home: it moves.
 */
export const holdsCopy = (entry: RailEntry, section: string) =>
  entry.kind !== "page" && !homes.has(section);
/** Whether a row there can be taken out again, or moved on to another. */
export const ownSection = (section: string) =>
  !homes.has(section) && section !== "pins";

/** Team's own pages. */
const teamPages = new Set([
  "buzz.inbox/inbox",
  "buzz.drafts-and-sent/drafts-sent",
]);
/** Whether a row can be put there: Team keeps to its views and own pages. */
export const accepts = (entry: RailEntry, section: string) =>
  section !== "messages" || teamPages.has(entry.id);

/** Cards, expanded lists and conversation routing share the same membership. */
export function railSections(
  layout: RailLayout,
  contributions: readonly RailSection[] = [],
) {
  const sections = new Map(
    [...builtins, ...contributions, ...layout.sections].map((section) => [
      section.id,
      section.title,
    ]),
  );
  // A conversation saved into Team, Solo or Plugins stays where it lives.
  const placements = layout.placements.filter(
    (item) =>
      sections.has(item.section) &&
      accepts(item.entry, item.section) &&
      (item.entry.kind === "page" || holdsCopy(item.entry, item.section)),
  );
  /** Where each moved app row is; copies leave their own list alone. */
  const assigned = new Map(
    placements
      .filter((item) => item.entry.kind === "page")
      .map((item) => [item.entry.id, item.section]),
  );
  const placed = new Map<string, RailEntry[]>();
  for (const { entry, section } of placements) {
    const entries = placed.get(section) ?? [];
    entries.push(entry);
    placed.set(section, entries);
  }
  return {
    sections,
    assigned,
    entries(
      id: string,
      defaults: readonly RailEntry[],
      current?: ReadonlyMap<string, RailEntry>,
    ) {
      const entries = new Map(
        defaults
          .filter(
            (entry) =>
              id === "agents" ||
              !assigned.has(entry.id) ||
              assigned.get(entry.id) === id,
          )
          .map((entry) => [entry.id, entry]),
      );
      for (const entry of placed.get(id) ?? [])
        entries.set(entry.id, current?.get(entry.id) ?? entry);
      return [...entries.values()];
    },
    owner(matches: (entry: RailEntry) => boolean) {
      return placements.find((item) => matches(item.entry))?.section;
    },
  };
}
