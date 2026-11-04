import { useSyncExternalStore } from "react";
import { OwnedContribution } from "../../plugins/OwnedContribution";
import type { Backdrops } from "./service";

/** Renders nothing unless a plugin registers a backdrop. Each one gets its own
 * stacking context, so later registrations paint above earlier ones whatever
 * z-index they use inside; a failing one disappears without a message. */
export function ShellBackdrops({ backdrops }: { backdrops: Backdrops }) {
  const entries = useSyncExternalStore(backdrops.subscribe, backdrops.snapshot);
  if (!entries.length) return null;
  return (
    <div className="shell-backdrop" aria-hidden="true" inert>
      {entries.map((entry) => (
        <OwnedContribution
          key={entry.key}
          entry={entry}
          registry={backdrops}
          fallback={null}
        >
          {({ component: Layer }) => (
            <div className="shell-backdrop-layer">
              <Layer />
            </div>
          )}
        </OwnedContribution>
      ))}
    </div>
  );
}
