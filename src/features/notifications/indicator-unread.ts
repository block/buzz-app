import type { Communities } from "../communities/service";
import type { RelaySession } from "../relay/session";
import { communityDestination } from "../communities/destination";
import type { OpenTarget } from "../navigation/targets";
import type { BadgeActivity } from "./preferences";

/** Notification gates: only conversations they allow light the indicator. */
export type IndicatorGates = Readonly<{
  allows(target: OpenTarget): boolean;
  badgeActivity?(): BadgeActivity;
  subscribe(listener: () => void): () => void;
}>;

/** A host projection of retained unread evidence, never a new read owner. */
export function bindUnreadIndicator(
  communities: Communities,
  project: (unread: boolean, count?: number) => void,
  gates?: IndicatorGates,
) {
  let closed = false;
  let session: RelaySession | undefined;
  let identity = "";
  let previous: boolean | undefined;
  let previousCount = 0;
  let stopRoster = () => {};
  let refresh = () => {};
  let stopPreferences = () => {};
  const channels = new Map<string, () => void>();
  const publish = (unread: boolean, count = 0) => {
    if (unread === previous && count === previousCount) return;
    previous = unread;
    previousCount = count;
    if (count > 0) project(unread, count);
    else project(unread);
  };
  const clear = () => {
    stopRoster();
    stopPreferences();
    refresh = () => {};
    for (const stop of channels.values()) stop();
    channels.clear();
  };
  const update = () => {
    if (closed) return;
    const client = communities.snapshot();
    const relay = communities.relay.snapshot();
    const next = `${client.viewer ?? ""}:${client.selected ?? ""}`;
    const owned =
      relay.status === "ready" &&
      client.viewer &&
      relay.viewer === client.viewer &&
      client.memberships.some((item) => item.id === client.selected)
        ? relay.session
        : undefined;
    if (session === owned && identity === next) return;
    clear();
    session = owned;
    identity = next;
    publish(false);
    if (!owned) return;
    const viewer = client.viewer as string;
    const directChannels = new Set<string>();
    const scope = gates && {
      viewer,
      communityOrigin: communityDestination(client.selected as string).url,
    };
    const valid = () => !closed && session === owned && identity === next;
    const changed = () => {
      if (!valid()) return;
      const preferences = owned.sidebarPreferences.snapshot();
      if (
        preferences.status !== "ready" &&
        preferences.status !== "unsupported"
      ) {
        publish(false);
        return;
      }
      const muted = new Set(preferences.data?.muted ?? []);
      const activity = gates?.badgeActivity?.() ?? "all";
      let unread = false;
      let count = 0;
      for (const channelId of channels.keys()) {
        if (muted.has(channelId)) continue;
        const snapshot = owned.unread.snapshot({ kind: "channel", channelId });
        // The Dock follows the sidebar rows, which opening a channel quiets.
        const observed =
          snapshot.row?.observedCount ?? snapshot.observedCount ?? 0;
        const mentions =
          (snapshot.row ? snapshot.row.mentionCount : snapshot.mentionCount) ??
          0;
        const direct = directChannels.has(channelId);
        count += direct ? observed : mentions;
        if (
          (activity === "all" || direct) &&
          (snapshot.manual !== "none" || observed > 0)
        )
          unread = true;
      }
      publish(unread || count > 0, count);
    };
    stopPreferences = owned.sidebarPreferences.subscribe(changed);
    changed();
    const roster = () => {
      if (!valid()) return;
      const eligible = owned.channels.list().channels.filter(
        (channel) =>
          !channel.huddle &&
          !channel.metadataPending &&
          channel.members?.includes(viewer) &&
          (!gates ||
            !scope ||
            gates.allows({
              version: 1,
              kind: "conversation",
              scope,
              channelId: channel.id,
            })),
      );
      const ids = new Set(eligible.map((channel) => channel.id));
      directChannels.clear();
      for (const channel of eligible)
        if (channel.channelType === "dm") directChannels.add(channel.id);
      for (const [id, stop] of channels) {
        if (ids.has(id)) continue;
        stop();
        channels.delete(id);
      }
      for (const channelId of ids) {
        if (!channels.has(channelId))
          channels.set(
            channelId,
            owned.unread.subscribe({ kind: "channel", channelId }, changed),
          );
      }
      changed();
    };
    stopRoster = owned.channels.subscribeList(roster);
    refresh = roster;
    roster();
  };
  const stop = communities.subscribe(update);
  const stopRelay = communities.relay.subscribe(update);
  const stopGates = gates?.subscribe(() => refresh()) ?? (() => {});
  update();
  return () => {
    if (closed) return;
    closed = true;
    stop();
    stopRelay();
    stopGates();
    clear();
    session = undefined;
    publish(false);
  };
}
