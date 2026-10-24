import { useSyncExternalStore } from "react";
import type { RelaySession } from "../relay/session";
import { soloNavigationFor } from "./solo-navigation";
const empty = () => undefined;
const noop = () => () => {};
export function useSoloNavigation(session: RelaySession) {
  const reader = soloNavigationFor(session);
  return useSyncExternalStore(
    reader?.subscribe ?? noop,
    reader?.snapshot ?? empty,
  );
}
