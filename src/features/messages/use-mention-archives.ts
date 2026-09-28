import { useEffect, useSyncExternalStore } from "react";
import type { RelaySession } from "../relay/session";
const noop = () => () => {};
const unavailable = { status: "unavailable", archived: [] } as const;
const empty = () => unavailable;
/** Observe existing archive evidence; only an open chooser demands its lazy read. */
export function useMentionArchives(session: RelaySession, demand = false) {
  const snapshot = useSyncExternalStore(
    session.archives?.subscribe ?? noop,
    session.archives?.snapshot ?? empty,
    empty,
  );
  useEffect(() => {
    if (demand) void session.archives?.ensure();
  }, [session, demand]);
  return snapshot;
}
