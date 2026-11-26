import { useState } from "react";
import { readView, writeView } from "../../shared/view-state";

/** How search lists every conversation before anything is typed. */
export type BrowseSort = "activity" | "name";

// Kept on this device for the account and community (the usage scope).
const KEY = "search-browse-sort";

const read = (scope: string | undefined): BrowseSort =>
  scope && readView<unknown>(scope, KEY, "activity") === "name"
    ? "name"
    : "activity";

/** The chosen order, latest activity first unless the person chose names. */
export function useBrowseSort(scope: string | undefined) {
  const [kept, setKept] = useState(() => ({ scope, sort: read(scope) }));
  // Another account or community reads its own choice.
  if (kept.scope !== scope) setKept({ scope, sort: read(scope) });
  const sort = kept.scope === scope ? kept.sort : read(scope);
  const choose = (next: BrowseSort) => {
    setKept({ scope, sort: next });
    if (scope) writeView(scope, KEY, next);
  };
  return [sort, choose] as const;
}
