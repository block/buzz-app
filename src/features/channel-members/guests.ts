import { useEffect, useMemo, useSyncExternalStore } from "react";
import type { ComposerSession } from "../messages/composer-session";
import { useListedChannel } from "../relay/listed-channel";

type Roles = NonNullable<ComposerSession["memberAdministration"]>;

const none: ReadonlySet<string> = new Set();
const unsubscribed = () => () => {};
/** The roster each session last read roles for, per channel. */
const refreshed = new WeakMap<Roles, Map<string, string>>();

/** The members the signed roster marks Guest ("Viewing only"). Presentation
 * only: the relay still decides who may post. Unknown roles give no guests. */
export function guestKeys(roles: Roles | undefined, channelId: string) {
  const known = roles?.snapshot(channelId).authority.roles ?? {};
  const keys = Object.entries(known).flatMap(([key, role]) =>
    role === "guest" ? [key] : [],
  );
  return keys.length ? new Set(keys) : none;
}

/** Reads a channel's roles once the relay confirms its roster, again when the
 * roster changes, then follows changes. Like the members panel, it waits out
 * downloaded membership: role reads fail until the relay confirms it. */
export function useChannelGuests(
  session: ComposerSession,
  channelId: string | undefined,
  enabled = true,
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
  const readable = enabled && roster !== undefined;
  useEffect(() => {
    if (!roles || !channelId || !readable) return;
    let asked = refreshed.get(roles);
    if (!asked) {
      asked = new Map();
      refreshed.set(roles, asked);
    }
    // The chooser remounts on every keystroke; read once per roster.
    if (asked.get(channelId) === roster) return;
    asked.set(channelId, roster);
    void roles.refresh(channelId).catch(() => {});
  }, [roles, channelId, readable, roster]);
  // Session access invalidation can clear roles without changing the roster.
  const idle = state?.status === "idle";
  useEffect(() => {
    if (roles && channelId && readable && idle)
      void roles.refresh(channelId).catch(() => {});
  }, [roles, channelId, readable, idle]);
  return useMemo(
    () => (state && channelId ? guestKeys(roles, channelId) : none),
    [roles, channelId, state],
  );
}
