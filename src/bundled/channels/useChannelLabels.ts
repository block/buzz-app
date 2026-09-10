import { useEffect, useMemo, useSyncExternalStore } from "react";
import type { ChannelSummary } from "../../features/relay/contracts";
import type { ProfileQueries } from "../../features/relay/profile-directory";
import { selectProfiles } from "../../features/relay/profile-selection";

/** Visible labels share the session's bounded profile directory, not per-row fetches. */
export function useChannelLabels(
  roster: readonly ChannelSummary[],
  queries: ProfileQueries,
) {
  const channels = useMemo(
    () =>
      roster.filter(
        (channel) =>
          !channel.archived &&
          (!channel.hidden || channel.channelType === "dm"),
      ),
    [roster],
  );
  const key = [
    ...new Set(channels.flatMap((channel) => channel.participants ?? [])),
  ]
    .sort()
    .slice(0, 1024)
    .join(":");
  const ids = useMemo(() => (key ? key.split(":") : []), [key]);
  const selection = useMemo(() => selectProfiles(queries, ids), [queries, ids]);
  const profiles = useSyncExternalStore(
    selection.subscribe,
    selection.snapshot,
    selection.snapshot,
  );
  // Access loss can purge loaded names or abort a cold fetch without changing
  // DM participants. Retry for missing names or changed channel membership,
  // not for message previews/renders; keep enrichment in the background.
  const membership = roster
    .map((channel) => channel.id)
    .sort()
    .join(":");
  const missing = ids.filter((id) => !profiles.has(id)).join(":");
  useEffect(() => {
    if (membership && missing)
      void queries.ensure(missing.split(":"), "background").catch(() => {});
  }, [queries, missing, membership]);
  return useMemo(
    () =>
      channels.map((channel) => {
        if (channel.channelType !== "dm" || !channel.participants)
          return channel;
        const name = channel.participants.length
          ? channel.participants
              .map((id) => profiles.get(id)?.name ?? id.slice(0, 10))
              .join(", ")
          : "Notes to self";
        return { ...channel, name };
      }),
    [channels, profiles],
  );
}
