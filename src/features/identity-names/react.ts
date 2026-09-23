import { useSyncExternalStore, useCallback } from "react";
import type { RelaySession } from "../relay/session";
import type { IdentityNameView } from "./service";
const noop = () => () => {};
const zero = () => 0;
/** The interface arrives through the captured session, never a global lookup. */
export function useIdentityNames(names: IdentityNameView | undefined) {
  const revision = useSyncExternalStore(
    names?.subscribe ?? noop,
    names?.snapshot ?? zero,
    zero,
  );
  return useCallback(
    (
      pubkey: string,
      fallback: string,
      candidates?: readonly string[],
    ): string => {
      // Invalidate memoized labels and completion choices on name changes.
      void revision;
      return names?.resolve(pubkey, fallback, candidates) ?? fallback;
    },
    [names, revision],
  );
}

const noChannels = () => undefined;
const noMembers: readonly string[] = [];
/** Channel membership defines ambiguity, not the community-wide profile cache. */
export function useChannelIdentityNames(
  session: RelaySession | undefined,
  channelId: string | undefined,
) {
  const list = useSyncExternalStore(
    session?.channels?.subscribeList ?? noop,
    session?.channels?.list ?? noChannels,
    noChannels,
  );
  const members =
    list?.channels.find((channel) => channel.id === channelId)?.members ??
    noMembers;
  const resolve = useIdentityNames(session?.names);
  return useCallback(
    (pubkey: string, fallback: string) => resolve(pubkey, fallback, members),
    [resolve, members],
  );
}
