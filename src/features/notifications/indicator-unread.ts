import type { Communities } from "../communities/service";
import type { RelaySession } from "../relay/session";
import { communityDestination } from "../communities/destination";
import type { OpenTarget } from "../navigation/targets";
import { NO_BADGE, type UnreadBadge } from "./indicator";

/** Notification gates: only conversations they allow light the indicator. */
export type IndicatorGates = Readonly<{
  allows(target: OpenTarget): boolean;
  subscribe(listener: () => void): () => void;
}>;

/**
 * A host projection of existing evidence, never a new read owner. The count
 * is observed unread direct messages and mentions of the viewer; muted
 * conversations contribute only their mentions. It is not an exact relay total.
 */
export function bindUnreadIndicator(
  communities: Communities,
  project: (badge: UnreadBadge) => void,
  gates?: IndicatorGates,
) {
  let closed = false;
  let session: RelaySession | undefined;
  let identity = "";
  let previous: UnreadBadge | undefined;
  let stopRoster = () => {};
  let refresh = () => {};
  let stopPreferences = () => {};
  const channels = new Map<string, () => void>();
  const publish = (badge: UnreadBadge) => {
    if (badge.unread === previous?.unread && badge.count === previous.count)
      return;
    previous = badge;
    project(badge);
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
    publish(NO_BADGE);
    if (!owned) return;
    const viewer = client.viewer as string;
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
        publish(NO_BADGE);
        return;
      }
      const muted = new Set(preferences.data?.muted ?? []);
      let unread = false;
      let count = 0;
      for (const channelId of channels.keys()) {
        const snapshot = owned.unread.snapshot({ kind: "channel", channelId });
        count += snapshot.mentionCount ?? 0;
        if (muted.has(channelId)) continue;
        count += snapshot.directCount ?? 0;
        unread ||=
          snapshot.manual !== "none" || (snapshot.observedCount ?? 0) > 0;
      }
      publish({ unread: unread || count > 0, count });
    };
    stopPreferences = owned.sidebarPreferences.subscribe(changed);
    changed();
    const roster = () => {
      if (!valid()) return;
      const ids = new Set(
        owned.channels
          .list()
          .channels.filter(
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
          )
          .map((channel) => channel.id),
      );
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
    publish(NO_BADGE);
  };
}
