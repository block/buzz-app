import type { Communities } from "../communities/service";
import { communityDestination } from "../communities/destination";
import type { RelayData } from "../relay/service";
import type { RelaySession } from "../relay/session";
import type { OpenTarget } from "../navigation/targets";

/** Notification gates: only conversations they allow count as unread. */
export type UnreadGates = Readonly<{
  allows(target: OpenTarget): boolean;
  subscribe(listener: () => void): () => void;
}>;

/** One community's unread, as its sidebar rows show it. `attention` counts
 * the rows' mentions, DMs and followed-thread replies. */
export type CommunityUnread = Readonly<{ unread: boolean; attention: number }>;

/** Observes one community session's existing unread evidence, never a new read
 * owner. `publish` gets `undefined` until confirmed mutes are known, so an
 * unknown community never reads as all read. With `known`, it also gets
 * `undefined` while the session's unread is stale (its connection dropped,
 * until the reconnect's read finishes) or no counted channel has observed
 * evidence; channels without it are left out of the count. */
export function observeCommunityUnread(
  session: RelaySession,
  viewer: string,
  communityOrigin: string,
  publish: (state: CommunityUnread | undefined) => void,
  gates?: UnreadGates,
  known = false,
) {
  let closed = false;
  const channels = new Map<string, () => void>();
  const scope = { viewer, communityOrigin };
  const changed = () => {
    if (closed) return;
    const preferences = session.sidebarPreferences.snapshot();
    if (preferences.status !== "ready" && preferences.status !== "unsupported")
      return publish(undefined);
    const muted = new Set(preferences.data?.muted ?? []);
    let unread = false;
    let attention = 0;
    let observed = 0;
    for (const channelId of channels.keys()) {
      if (muted.has(channelId)) continue;
      const snapshot = session.unread.snapshot({ kind: "channel", channelId });
      if (known) {
        if (snapshot.freshness === "stale") return publish(undefined);
        if (snapshot.coverage !== "observed") continue;
        observed++;
      }
      // Follow the sidebar rows, which opening a channel quiets.
      const row = snapshot.row ?? snapshot;
      if (snapshot.manual !== "none" || (row.observedCount ?? 0) > 0)
        unread = true;
      attention += row.attentionCount ?? 0;
    }
    if (known && !observed) return publish(undefined);
    publish({ unread, attention });
  };
  const roster = () => {
    if (closed) return;
    const ids = new Set(
      session.channels
        .list()
        .channels.filter(
          (channel) =>
            !channel.huddle &&
            !channel.metadataPending &&
            channel.members?.includes(viewer) &&
            (!gates ||
              gates.allows({
                version: 1,
                kind: "conversation",
                scope,
                channelId: channel.id,
              })),
        )
        .map((channel) => channel.id),
    );
    for (const [id, stop] of channels) {
      if (ids.has(id)) continue;
      stop();
      channels.delete(id);
    }
    for (const channelId of ids)
      if (!channels.has(channelId))
        channels.set(
          channelId,
          session.unread.subscribe({ kind: "channel", channelId }, changed),
        );
    changed();
  };
  const stopPreferences = session.sidebarPreferences.subscribe(changed);
  const stopRoster = session.channels.subscribeList(roster);
  const stopGates = gates?.subscribe(roster) ?? (() => {});
  roster();
  return () => {
    if (closed) return;
    closed = true;
    stopPreferences();
    stopRoster();
    stopGates();
    for (const stop of channels.values()) stop();
    channels.clear();
  };
}

/** Unread for every joined community, keyed by community id. It opens each
 * one's session in the background and starts its unread repair once, as
 * visiting it would. Communities without a ready session, or whose unread is
 * stale or unobserved, are absent. */
export function createCommunityUnreads(
  communities: Communities,
  gates?: UnreadGates,
) {
  type Entry = {
    relay: RelayData;
    stopRelay: () => void;
    session?: RelaySession | undefined;
    stop?: (() => void) | undefined;
  };
  const entries = new Map<string, Entry>();
  const listeners = new Set<() => void>();
  let states: ReadonlyMap<string, CommunityUnread> = new Map();
  let closed = false;
  const set = (id: string, state: CommunityUnread | undefined) => {
    const previous = states.get(id);
    if (
      previous === state ||
      (previous &&
        state &&
        previous.unread === state.unread &&
        previous.attention === state.attention)
    )
      return;
    const next = new Map(states);
    if (state) next.set(id, state);
    else next.delete(id);
    states = next;
    for (const fn of listeners) fn();
  };
  const bind = (id: string, entry: Entry, viewer: string | undefined) => {
    const relay = entry.relay.snapshot();
    const session =
      relay.status === "ready" && viewer && relay.viewer === viewer
        ? relay.session
        : undefined;
    if (session === entry.session) return;
    entry.stop?.();
    entry.stop = undefined;
    entry.session = session;
    set(id, undefined);
    // Without it, unread holds only messages that arrived since connecting.
    if (session) void session.unread.ensure().catch(() => {});
    if (session && viewer)
      entry.stop = observeCommunityUnread(
        session,
        viewer,
        communityDestination(id).url,
        (state) => set(id, state),
        gates,
        true,
      );
  };
  const drop = (id: string, entry: Entry) => {
    entry.stopRelay();
    entry.stop?.();
    entries.delete(id);
    set(id, undefined);
  };
  const update = () => {
    if (closed) return;
    const { viewer, memberships } = communities.snapshot();
    const joined = new Set(viewer ? memberships.map((m) => m.id) : []);
    for (const [id, entry] of entries)
      if (!joined.has(id) || communities.open(id) !== entry.relay)
        drop(id, entry);
    for (const id of joined) {
      let entry = entries.get(id);
      if (!entry) {
        const relay = communities.open(id);
        if (!relay) continue;
        const created: Entry = { relay, stopRelay: () => {} };
        created.stopRelay = relay.subscribe(() =>
          bind(id, created, communities.snapshot().viewer),
        );
        entries.set(id, created);
        entry = created;
      }
      bind(id, entry, viewer);
    }
  };
  const stopCommunities = communities.subscribe(update);
  const stopRelay = communities.relay.subscribe(update);
  update();
  return {
    snapshot: () => states,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose() {
      if (closed) return;
      closed = true;
      stopCommunities();
      stopRelay();
      for (const [id, entry] of entries) drop(id, entry);
      listeners.clear();
    },
  };
}

export type CommunityUnreads = ReturnType<typeof createCommunityUnreads>;
