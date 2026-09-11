import { useEffect, useSyncExternalStore } from "react";
import type { RelaySession } from "../../features/relay/session";

/** The session retains groups/stars across page unmounts; React only observes. */
export function useSidebarPreferences(
  queries: RelaySession["sidebarPreferences"],
) {
  const snapshot = useSyncExternalStore(
    queries.subscribe,
    queries.snapshot,
    queries.snapshot,
  );
  useEffect(() => {
    if (snapshot.status === "idle") void queries.ensure();
  }, [queries, snapshot.status]);
  return {
    ...snapshot,
    status: snapshot.status === "idle" ? ("loading" as const) : snapshot.status,
    reload: queries.refresh,
  };
}
