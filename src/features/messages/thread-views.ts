import { createContext, useContext, useSyncExternalStore } from "react";
import type { RelaySession } from "../relay/session";
import type { ThreadView } from "../relay/threads";

/** Workspace-local handles to already-owned views: no cache, read, or capture lease. */
export function createThreadViews() {
  const entries = new Set<{
    session: RelaySession;
    channel: string;
    view: ThreadView;
  }>();
  const listeners = new Set<() => void>();
  const changed = () => {
    for (const listener of listeners) listener();
  };
  return {
    register(session: RelaySession, channel: string, view: ThreadView) {
      const entry = { session, channel, view };
      entries.add(entry);
      const stop = view.subscribe(changed);
      changed();
      return () => {
        if (!entries.delete(entry)) return;
        stop();
        changed();
      };
    },
    read(session: RelaySession | undefined, channel: string, root: string) {
      for (const entry of entries) {
        if (entry.session !== session || entry.channel !== channel) continue;
        const snapshot = entry.view.snapshot();
        if (snapshot.root?.id === root) return snapshot;
      }
      return undefined;
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
export const ThreadViews = createContext<
  ReturnType<typeof createThreadViews> | undefined
>(undefined);
export const useThreadViews = () => useContext(ThreadViews);
const none = () => () => {};
export function useLoadedThread(
  session: RelaySession | undefined,
  channel: string,
  root: string,
) {
  const views = useThreadViews();
  return useSyncExternalStore(
    views?.subscribe ?? none,
    () => views?.read(session, channel, root),
    () => undefined,
  );
}
