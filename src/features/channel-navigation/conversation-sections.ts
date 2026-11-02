import { useCallback, useMemo, useSyncExternalStore } from "react";
import type { ContributionReader } from "../conversation/contracts";
import type { ConversationSection } from "../conversation/service";
import type { ChannelSummary } from "../relay/contracts";
import type { RelaySession } from "../relay/session";

/** Contributed sections show this many conversations until Show more. */
export const SECTION_CAP = 8;
export const SECTION_STEP = 10;
const none: readonly never[] = [];
const noSubscription = () => () => {};

export function isContributedSection(key: string) {
  return key.startsWith("plugin:");
}

/** Each contributed section's channel IDs for `session`, in display order. */
export function useConversationSections(
  reader: ContributionReader<ConversationSection> | undefined,
  session: RelaySession,
) {
  const contributions = useSyncExternalStore(
    reader?.subscribe ?? noSubscription,
    () => reader?.snapshot() ?? none,
  );
  // Plugins are trusted, but one failing section must not take the sidebar.
  const sources = useMemo(
    () =>
      contributions.flatMap((section) => {
        try {
          const channels = section.channels(session);
          const read = () => {
            try {
              const ids = channels.snapshot();
              return Array.isArray(ids)
                ? ids.filter((id) => typeof id === "string")
                : [];
            } catch {
              return [];
            }
          };
          return [
            {
              key: `plugin:${section.key}`,
              title: section.title,
              subscribe: channels.subscribe,
              read,
            },
          ];
        } catch {
          return [];
        }
      }),
    [contributions, session],
  );
  const subscribe = useCallback(
    (listener: () => void) => {
      const stops = sources.flatMap(({ subscribe }) => {
        try {
          return [subscribe(listener)];
        } catch {
          return [];
        }
      });
      return () => {
        for (const stop of stops) stop();
      };
    },
    [sources],
  );
  const snapshot = useCallback(
    () => JSON.stringify(sources.map(({ read }) => read())),
    [sources],
  );
  const ids = useSyncExternalStore(subscribe, snapshot, snapshot);
  return useMemo(() => {
    const lists = JSON.parse(ids) as string[][];
    return sources.map(({ key, title }, i) => ({
      key,
      title,
      ids: lists[i] ?? [],
    }));
  }, [sources, ids]);
}

/** Contributed sections arrange rows the sidebar already lists; they never add
 * channels. */
export function withConversationSections<R extends ChannelSummary>(
  listed: readonly R[],
  contributed: readonly {
    key: string;
    title: string;
    ids: readonly string[];
  }[],
) {
  const rows = new Map(listed.map((row) => [row.id, row]));
  return contributed.flatMap(({ key, title, ids }) => {
    const shown = ids.flatMap((id) => rows.get(id) ?? []);
    return shown.length ? [{ key, title, rows: shown }] : [];
  });
}
