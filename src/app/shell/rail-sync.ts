import { useCallback, useSyncExternalStore } from "react";
import { RailLayoutConflict } from "../../features/relay/transport";
import type { RelaySession } from "../../features/relay/session";
import {
  readView,
  subscribeView,
  viewRevision,
  writeView,
} from "../../shared/view-state";
import { parseRailLayout } from "./rail-layout";
import { parseRailEntries } from "./rail-pins";

const LAYOUT = "navigation-layout:v2";
const PINS = "navigation-pins:v1";
const TEAM = "navigation-team-expanded:v1";
/** The record this device's copy last matched, and whether it changed since. */
const SYNC = "navigation-sync:v1";

/** Whether Team shows its rows rather than its icons. */
export function useTeamExpanded(scope: string) {
  const subscribe = useCallback(
    (listener: () => void) => subscribeView(scope, listener),
    [scope],
  );
  const expanded =
    useSyncExternalStore(subscribe, () => viewRevision(scope, TEAM)) === "true";
  return [expanded, (next: boolean) => writeView(scope, TEAM, next)] as const;
}

const local = (scope: string) => ({
  version: 1,
  ...parseRailLayout(readView<unknown>(scope, LAYOUT, null)),
  pins: parseRailEntries(readView<unknown>(scope, PINS, [])),
  teamExpanded: readView<unknown>(scope, TEAM, false) === true,
});
/** Equal arrangements read the same whatever order their keys were saved in. */
const canonical = (value: unknown) =>
  JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.entries(item).sort(([a], [b]) => (a < b ? -1 : 1)),
        )
      : item,
  );

/**
 * Keeps this device's sidebar arrangement and the account's saved one the
 * same, until the returned stop. The device's copy is what the sidebar draws:
 * a change made here is sent, and one saved by another device replaces it.
 * A change here that was not sent yet wins over the saved one. An account
 * with nothing saved starts from the sections its earlier app made.
 */
export function syncRail(session: RelaySession, scope: string, viewer: string) {
  const remote = session.railLayout;
  if (!remote) return () => {};
  let stopped = false;
  let applying = false;
  let running = false;
  let again = false;
  let stopEarlier: (() => void) | undefined;
  const state = () =>
    readView<{ base: number; dirty: boolean }>(scope, SYNC, {
      base: 0,
      dirty: false,
    });
  const run = async () => {
    if (running) {
      again = true;
      return;
    }
    running = true;
    try {
      do {
        again = false;
        const head = await remote.read();
        if (stopped) return;
        const mine = local(scope);
        const saved = head.payload && {
          version: 1,
          ...parseRailLayout(head.payload),
          pins: parseRailEntries(head.payload.pins),
          teamExpanded: head.payload.teamExpanded === true,
        };
        if (saved && canonical(saved) === canonical(mine)) {
          writeView(scope, SYNC, { base: head.createdAt, dirty: false });
        } else if (saved && !state().dirty) {
          applying = true;
          try {
            writeView(scope, LAYOUT, {
              order: saved.order,
              sections: saved.sections,
              placements: saved.placements,
            });
            writeView(scope, PINS, saved.pins);
            writeView(scope, TEAM, saved.teamExpanded);
            writeView(scope, SYNC, { base: head.createdAt, dirty: false });
          } finally {
            applying = false;
          }
        } else if (!saved && !mine.sections.length && !state().dirty) {
          // Nothing saved yet: start from the sections an earlier app made.
          // A channel the viewer no longer has is left behind, so both the
          // sections and the channel list must have loaded.
          const earlier = session.sidebarPreferences.snapshot();
          const listed = session.channels.list();
          const loaded = () =>
            session.sidebarPreferences.snapshot().status === "ready" &&
            session.channels.list().status === "ready";
          if (!loaded()) {
            if (!stopEarlier) {
              const retry = () => {
                if (!loaded()) return;
                stopEarlier?.();
                void run();
              };
              const stops = [
                session.sidebarPreferences.subscribe(retry),
                session.channels.subscribeList(retry),
              ];
              stopEarlier = () => {
                for (const end of stops) end();
              };
            }
          } else if (earlier.data?.sections.length) {
            const names = new Map(
              listed.channels
                .filter((row) => !row.archived)
                .map((row) => [row.id, row.name]),
            );
            const ids = new Set(earlier.data.sections.map(({ id }) => id));
            writeView(scope, LAYOUT, {
              order: mine.order,
              sections: [...earlier.data.sections]
                .sort((a, b) => a.order - b.order)
                .map(({ id, name }) => ({ id: `custom:${id}`, title: name })),
              placements: [
                ...mine.placements,
                ...Object.entries(earlier.data.assignments)
                  .filter(
                    ([channelId, section]) =>
                      ids.has(section) && names.has(channelId),
                  )
                  .map(([channelId, section]) => ({
                    section: `custom:${section}`,
                    entry: {
                      id: `channel:${channelId}`,
                      label: names.get(channelId) ?? "",
                      kind: "channel",
                      target: {
                        version: 1,
                        kind: "conversation",
                        scope: {
                          viewer,
                          communityOrigin: scope.slice(0, -(viewer.length + 1)),
                        },
                        channelId,
                      },
                    },
                  })),
              ],
            });
          }
        } else if (state().dirty) {
          try {
            const base = await remote.write(mine, head.createdAt);
            if (stopped) return;
            // A change made while this one was sent is still to send.
            writeView(scope, SYNC, { base, dirty: again });
          } catch (error) {
            if (!(error instanceof RailLayoutConflict)) throw error;
            again = true;
          }
        }
      } while (again && !stopped);
    } catch {
      // Offline or refused: the copy stays changed, and the next change or
      // reconnect sends it.
    } finally {
      running = false;
    }
  };
  const stopLocal = subscribeView(scope, (key) => {
    // Only a write to the arrangement is a change to send. A notice that
    // names no key, or a key that was removed, is this device forgetting
    // what it kept, as when it leaves the community.
    if (
      applying ||
      (key !== LAYOUT && key !== PINS && key !== TEAM) ||
      viewRevision(scope, key) == null
    )
      return;
    writeView(scope, SYNC, { ...state(), dirty: true });
    void run();
  });
  const stopRemote = remote.changed((createdAt) => {
    if (createdAt === undefined || createdAt > state().base) void run();
  });
  void run();
  return () => {
    stopped = true;
    stopLocal();
    stopRemote();
    stopEarlier?.();
  };
}
