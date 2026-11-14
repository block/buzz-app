import { useEffect, useMemo, useSyncExternalStore } from "react";
import type { ComposerSession } from "../messages/composer-session";
import { useListedChannel } from "../relay/listed-channel";

type Roles = NonNullable<ComposerSession["memberAdministration"]>;

const none: ReadonlySet<string> = new Set();
const unsubscribed = () => () => {};
/** Per session and channel: the roster whose roles were last read, the
 * newest roster seen, and whether reads are still catching up to it. */
type Reads = { done?: string; wanted: string; running: boolean };
const refreshed = new WeakMap<Roles, Map<string, Reads>>();

/** Resolves once the channel's role state is no longer `from`. */
function changed(roles: Roles, id: string, from: unknown) {
  return new Promise<void>((resolve) => {
    const stop = roles.subscribe(() => {
      if (roles.snapshot(id) === from) return;
      stop();
      resolve();
    });
  });
}

/** Reads roles until a read has started after the newest roster arrived. A
 * read already under way (this one's, or another reader's) holds the older
 * roster, so it never counts for a roster that arrived during it. */
async function catchUp(roles: Roles, id: string, reads: Reads) {
  reads.running = true;
  try {
    while (reads.done !== reads.wanted) {
      const key = reads.wanted;
      const before = roles.snapshot(id);
      await roles.refresh(id).catch(() => {});
      const after = roles.snapshot(id);
      // No read ran: another one, or a member change, is under way. Read
      // again once it settles.
      if (
        after === before ||
        after.status === "loading" ||
        after.operation?.status === "pending"
      ) {
        await changed(roles, id, after);
        continue;
      }
      reads.done = key;
    }
  } finally {
    reads.running = false;
  }
}

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
 * roster's members or Guests change, then follows changes. Like the members
 * panel, it waits out downloaded membership: role reads fail until the relay
 * confirms it. */
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
  // Roles count too: a member↔guest change keeps the members.
  const roster = useListedChannel(session.channels, channelId, (channel) =>
    channel && !channel.cached
      ? `${(channel.members ?? []).join(":")}|${(channel.guests ?? []).join(":")}`
      : undefined,
  );
  const readable = enabled && roster !== undefined;
  useEffect(() => {
    if (!roles || !channelId || !readable) return;
    let byChannel = refreshed.get(roles);
    if (!byChannel) {
      byChannel = new Map();
      refreshed.set(roles, byChannel);
    }
    // The chooser remounts on every keystroke; read once per roster.
    let reads = byChannel.get(channelId);
    if (!reads) {
      reads = { wanted: roster, running: false };
      byChannel.set(channelId, reads);
    }
    reads.wanted = roster;
    if (!reads.running && reads.done !== roster)
      void catchUp(roles, channelId, reads);
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
