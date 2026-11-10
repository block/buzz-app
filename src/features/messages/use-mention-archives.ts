import { useEffect, useSyncExternalStore } from "react";
import type { ComposerSession } from "./composer-session";
import type { IdentityArchiveSnapshot } from "../relay/identity-archives";
const noop = () => () => {};
const unavailable: IdentityArchiveSnapshot = {
  status: "unavailable",
  archived: [],
};
const empty = () => unavailable;
/** Observe archive evidence; a demanding surface also reloads it after reconnect. */
export function useMentionArchives(
  session: ComposerSession,
  demand: boolean | "background" = false,
) {
  const snapshot = useSyncExternalStore(
    session.archives?.subscribe ?? noop,
    session.archives?.snapshot ?? empty,
    empty,
  );
  useEffect(() => {
    if (demand && snapshot.status !== "unavailable")
      void session.archives?.ensure({ background: demand === "background" });
  }, [session, demand, snapshot.status]);
  return snapshot;
}
