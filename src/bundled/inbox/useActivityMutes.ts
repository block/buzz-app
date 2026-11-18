import { useCallback, useMemo, useSyncExternalStore } from "react";
import type { RelaySession } from "../../features/relay/session";

/** Apply confirmed mutes to Activity without changing shared unread evidence. */
export function useActivityMutes({ sidebarPreferences }: RelaySession) {
  const readMutes = useCallback(() => {
    const snapshot = sidebarPreferences.snapshot();
    return snapshot.cached ? undefined : snapshot.data?.muted;
  }, [sidebarPreferences]);
  const muted = useSyncExternalStore(
    sidebarPreferences.subscribe,
    readMutes,
    readMutes,
  );
  return useMemo(() => new Set(muted), [muted]);
}
