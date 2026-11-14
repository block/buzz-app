import { useMemo, useRef } from "react";
import { useChannelDirectory } from "../../features/channels/useChannelDirectory";
import type { ChannelSummary } from "../../features/relay/contracts";

const collator = new Intl.Collator();

/** Search's browse group of open channels, and what opens search on it. */
export const CHANNELS_TO_JOIN = "Channels to join";

/** Read-only isn't unjoined: guests and saved channels are members too. */
const isMember = (channel: ChannelSummary) =>
  !channel.readOnly || !!channel.cached || channel.viewerRole === "guest";

/** The community's open channels the viewer hasn't joined, read while
 * `active`, for search's Channels to join. A–Z, except that rows hold their
 * places while a first read's later pages land: each page's new rows join
 * below the ones already shown, A–Z among themselves. */
export function useChannelsToJoin(
  queries: Parameters<typeof useChannelDirectory>[0],
  joined: readonly ChannelSummary[],
  active: boolean,
) {
  const directory = useChannelDirectory(queries, active);
  const arrival = useRef({
    directory: directory.directory,
    page: 0,
    seen: new Map<string, number>(),
  });
  if (arrival.current.directory !== directory.directory) {
    arrival.current.directory = directory.directory;
    arrival.current.page += 1;
  }
  for (const channel of directory.directory)
    if (!arrival.current.seen.has(channel.id))
      arrival.current.seen.set(channel.id, arrival.current.page);
  const channels = useMemo(() => {
    const member = new Set(joined.filter(isMember).map(({ id }) => id));
    const landed = ({ id }: ChannelSummary) =>
      arrival.current.seen.get(id) ?? arrival.current.page;
    return directory.directory
      .filter((channel) => !channel.archived && !member.has(channel.id))
      .sort(
        (a, b) =>
          landed(a) - landed(b) ||
          collator.compare(a.name, b.name) ||
          a.id.localeCompare(b.id),
      );
  }, [directory.directory, joined]);
  return {
    channels,
    loading: directory.loading,
    partial: directory.partial,
    error: directory.error,
    retry: directory.retry,
  };
}
