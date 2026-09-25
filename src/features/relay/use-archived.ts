import { useEffect, useMemo, useSyncExternalStore } from "react";
import type { RelaySession } from "./session";

/** Base Buzz discovery predicate: archived identities leave forward-looking pickers.
 * Fail-open while the snapshot is unknown, and never hides the viewer from
 * themself (NIP-IA archival must stay visible to its subject). */
export function useArchivedPredicate(
  session: RelaySession,
): (pubkey: string) => boolean {
  const snapshot = useSyncExternalStore(
    session.archives.subscribe,
    session.archives.snapshot,
    session.archives.snapshot,
  );
  useEffect(() => {
    if (snapshot.status === "idle") void session.archives.ensure();
  }, [session, snapshot.status]);
  return useMemo(() => {
    const archived = new Set(
      snapshot.status === "ready" ? snapshot.archived : [],
    );
    return (pubkey) => pubkey !== session.viewer && archived.has(pubkey);
  }, [session, snapshot]);
}
