import { useCallback, useSyncExternalStore } from "react";
import type { Presence } from "./presence";
/** Text and distinct symbols keep presence readable without color perception. */
export function PresenceIndicator({
  presence,
  pubkey,
  profile = false,
}: {
  presence: Presence;
  pubkey: string;
  profile?: boolean;
}) {
  const subscribe = useCallback(
    (listener: () => void) => presence.subscribe(pubkey, listener, profile),
    [presence, pubkey, profile],
  );
  const state = useSyncExternalStore(
    subscribe,
    () => `${presence.status(pubkey)}:${presence.limited(pubkey)}`,
  );
  const status = state.split(":")[0] as ReturnType<Presence["status"]>;
  // Missing or stale evidence is not proof that someone is offline.
  if (status === "unknown") return null;
  const label = {
    online: "Active",
    away: "Away",
    offline: "Offline",
  }[status];
  const symbol = { online: "●", away: "◐", offline: "○" }[status];
  return (
    <span
      role="img"
      className="text-body-sm text-secondary"
      aria-label={`Presence: ${label}`}
      title={
        presence.limited(pubkey)
          ? "Presence demand limit reached"
          : "Recent Buzz session status in this community; periodically refreshed"
      }
    >
      {symbol} {label}
    </span>
  );
}
