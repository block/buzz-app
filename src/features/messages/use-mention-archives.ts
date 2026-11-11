import { useEffect, useSyncExternalStore } from "react";
import type { ComposerSession } from "./composer-session";
import type { IdentityArchiveSnapshot } from "../relay/identity-archives";
const noop = () => () => {};
const unavailable: IdentityArchiveSnapshot = {
  status: "unavailable",
  archived: [],
};
const empty = () => unavailable;
/** Observe existing archive evidence; only an open chooser demands its lazy read. */
export function useMentionArchives(session: ComposerSession, demand = false) {
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
