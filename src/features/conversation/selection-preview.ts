import type { Contribution } from "../../plugins/contributions";
import type { MessageTextSelection, SelectionPreview } from "./contracts";

/** Every match remains available. Enable order never chooses a default winner. */
export function selectionPreviews(
  entries: readonly Contribution<SelectionPreview>[],
  selection: MessageTextSelection,
) {
  return entries
    .filter((entry) => {
      try {
        return entry.matches(selection);
      } catch {
        return false;
      }
    })
    .sort(
      (a, b) => (a.order ?? 0) - (b.order ?? 0) || a.key.localeCompare(b.key),
    );
}
