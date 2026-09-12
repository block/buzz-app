import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type {
  RelaySession,
  EventViewSnapshot,
} from "../../features/relay/session";
import type { ChannelSummary } from "../../features/relay/contracts";
import { selectProfiles } from "../../features/relay/profile-selection";
import { pulseRows, visibleChannels } from "./feed";
const empty: EventViewSnapshot = { status: "idle", events: [] };
const noop = () => () => {};

export function usePulseFeed(
  session: RelaySession,
  roster: readonly ChannelSummary[],
  ready: boolean,
) {
  const key = visibleChannels(roster)
    .map((channel) => channel.id)
    .sort()
    .join("\n");
  const [owned, setOwned] = useState<{
    key: string;
    view: ReturnType<RelaySession["observe"]>;
  }>();
  const [error, setError] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  // Allocate only after roster authority and in an effect: StrictMode/unload cannot leak handles.
  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt retries allocation failures.
  useEffect(() => {
    if (!ready || !key) return;
    try {
      const view = session.observe([
        {
          kinds: [9, 40002, 40003, 5, 9005, 7],
          "#h": key.split("\n"),
          // Multi-channel activity uses ordinary filters. The relay's top_level /
          // include_aux window extension requires exactly one channel; the shared
          // fold selects roots and applies any retained author edits/deletes here.
          limit: 200,
        },
      ]);
      setError(undefined);
      setOwned({ key, view });
      void view.refresh();
      return () => view.dispose();
    } catch (cause) {
      setError(String(cause));
    }
  }, [session, key, ready, attempt]);
  const view = ready && owned?.key === key ? owned.view : undefined;
  const snapshot = useSyncExternalStore(
    view?.subscribe ?? noop,
    view?.snapshot ?? (() => empty),
    view?.snapshot ?? (() => empty),
  );
  const rows = useMemo(
    () => pulseRows(snapshot.events, roster),
    [snapshot.events, roster],
  );
  const profileKey = [
    ...new Set([
      ...rows.slice(0, 200).map((row) => row.authorId),
      ...visibleChannels(roster)
        .filter((channel) => channel.channelType === "dm")
        .flatMap((channel) => channel.participants ?? []),
    ]),
  ]
    .sort()
    .slice(0, 1024)
    .join(":");
  const selection = useMemo(
    () =>
      selectProfiles(session.profiles, profileKey ? profileKey.split(":") : []),
    [session, profileKey],
  );
  const profiles = useSyncExternalStore(
    selection.subscribe,
    selection.snapshot,
    selection.snapshot,
  );
  const missing = profileKey
    .split(":")
    .filter((id) => id && !profiles.has(id))
    .join(":");
  // Include the whole roster identity: even hidden-channel revocation can purge shared profiles.
  const membership = roster
    .map((channel) => channel.id)
    .sort()
    .join("\n");
  useEffect(() => {
    if (membership && missing)
      void session.profiles
        .ensure(missing.split(":"), "background")
        .catch(() => {});
  }, [session, missing, membership]);
  return {
    rows,
    profiles,
    status: snapshot.status,
    error: error ?? snapshot.error,
    refresh: () => {
      if (view) void view.refresh();
      else setAttempt((value) => value + 1);
    },
  };
}
