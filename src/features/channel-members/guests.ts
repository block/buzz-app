import { useEffect, useMemo, useSyncExternalStore } from "react";
import type { ComposerSession } from "../messages/composer-session";
import type { ChannelSummary } from "../relay/contracts";
import { useListedChannel } from "../relay/listed-channel";

type Roles = NonNullable<ComposerSession["memberAdministration"]>;

const none: ReadonlySet<string> = new Set();
const unsubscribed = () => () => {};
/** The members each session last read roles for, per channel. */
const refreshed = new WeakMap<Roles, Map<string, string>>();

/** The members the relay-signed roster marks Guest ("Viewing only"), straight
 * from the channel list, so no role read under way can hold an older roster.
 * Presentation only: the relay still decides who may post. A downloaded
 * roster the relay hasn't confirmed gives no guests. */
export function guestKeys(channel: ChannelSummary | undefined) {
  return channel && !channel.cached && channel.guests?.length
    ? new Set(channel.guests)
    : none;
}

/** `guestKeys` for a listed channel, following its roster. */
export function useChannelGuests(
  session: Pick<ComposerSession, "channels">,
  channelId: string | undefined,
) {
  // The store keeps `guests` while the Guests stay the same.
  const guests = useListedChannel(session.channels, channelId, (channel) =>
    channel && !channel.cached ? channel.guests : undefined,
  );
  return useMemo(() => (guests?.length ? new Set(guests) : none), [guests]);
}

/** Reads a channel's roles once the relay confirms its roster and again when
 * its members change, so a send knows whether the viewer can make a
 * Viewing-only agent a member. Who is Viewing only comes from
 * `useChannelGuests`, not from these roles. Like the members panel, it waits
 * out downloaded membership: role reads fail until the relay confirms it. */
export function useChannelRoles(
  session: ComposerSession,
  channelId: string | undefined,
) {
  const roles = session.memberAdministration;
  const state = useSyncExternalStore(
    roles?.subscribe ?? unsubscribed,
    () => (roles && channelId ? roles.snapshot(channelId) : undefined),
    () => (roles && channelId ? roles.snapshot(channelId) : undefined),
  );
  const roster = useListedChannel(session.channels, channelId, (channel) =>
    channel && !channel.cached ? (channel.members ?? []).join(":") : undefined,
  );
  useEffect(() => {
    if (!roles || !channelId || roster === undefined) return;
    let asked = refreshed.get(roles);
    if (!asked) {
      asked = new Map();
      refreshed.set(roles, asked);
    }
    // The composer remounts often; read once per roster.
    if (asked.get(channelId) === roster) return;
    asked.set(channelId, roster);
    void roles.refresh(channelId).catch(() => {});
  }, [roles, channelId, roster]);
  // Session access invalidation can clear roles without changing the roster.
  const idle = state?.status === "idle";
  useEffect(() => {
    if (roles && channelId && roster !== undefined && idle)
      void roles.refresh(channelId).catch(() => {});
  }, [roles, channelId, roster, idle]);
}
