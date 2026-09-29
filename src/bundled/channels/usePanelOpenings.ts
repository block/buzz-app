import { useCallback, useRef, useState } from "react";
import { activitySelection } from "../../features/agents/activity-target";
import {
  profileActivityViewKey,
  profileKey,
} from "../../features/profiles/target";
import type { RegisteredPanel } from "../../features/panels/service";

export type PanelOpening = {
  channelId: string;
  panel: RegisteredPanel;
  target: string;
};

export function panelIdentity(target: string): string | undefined {
  return (
    activitySelection(target)?.agent ??
    profileActivityViewKey(target) ??
    profileKey(target)
  );
}

export function openingTab(opening: PanelOpening): string {
  const agent = panelIdentity(opening.target);
  return agent ? `agent:${agent}` : "target";
}

// The page owns these presentations, not the plugins or their shared feeds.
export function usePanelOpenings() {
  const [openings, setOpenings] = useState<readonly PanelOpening[]>([]);
  const current = useRef(openings);
  const [selected, select] = useState("thread");
  const replace = useCallback((next: readonly PanelOpening[]) => {
    // Retire captured callbacks before React commits a close or retarget.
    current.current = next;
    setOpenings(next);
  }, []);
  const open = useCallback(
    (next: PanelOpening | undefined) => {
      if (!next) {
        replace([]);
        select("thread");
        return;
      }
      const agent = panelIdentity(next.target);
      const retained = agent
        ? current.current.filter(
            (entry) =>
              entry.channelId === next.channelId && panelIdentity(entry.target),
          )
        : [];
      const index = retained.findIndex(
        (entry) => openingTab(entry) === openingTab(next),
      );
      const existing = retained[index];
      if (existing?.panel === next.panel && existing.target === next.target) {
        select(openingTab(existing));
        return;
      }
      if (index < 0) retained.push(next);
      else retained[index] = next;
      replace(retained);
      select(openingTab(next));
    },
    [replace],
  );
  const remove = useCallback(
    (entry: PanelOpening) => {
      const index = current.current.indexOf(entry);
      if (index < 0) return;
      const remaining = current.current.filter(
        (candidate) => candidate !== entry,
      );
      replace(remaining);
      const neighbor = remaining[Math.min(index, remaining.length - 1)];
      select((value) =>
        value === openingTab(entry)
          ? neighbor
            ? openingTab(neighbor)
            : "thread"
          : value,
      );
    },
    [replace],
  );
  const showThread = useCallback(
    (channelId: string) => {
      const retained = current.current.filter(
        (entry) => entry.channelId === channelId && panelIdentity(entry.target),
      );
      if (retained.length !== current.current.length) replace(retained);
      select("thread");
    },
    [replace],
  );
  return { openings, current, open, remove, selected, select, showThread };
}
