import { useEffect, useSyncExternalStore } from "react";
import { meGroups } from "../relay/me-preferences";
import type { RelaySession } from "../relay/session";

/** Plugin organization only. Neither placement nor plugin availability grants access. */
export function useMePlacement(session: RelaySession) {
  const placement = session.mePlacement;
  const state = useSyncExternalStore(placement.subscribe, placement.snapshot);
  useEffect(() => placement.ensure(), [placement]);
  const entry = meGroups(state.entries);
  const ids =
    !entry?.record.deleted && entry?.record.value.type === "groups"
      ? (entry.record.value.channels ?? [])
      : [];
  return { ...state, ids };
}
