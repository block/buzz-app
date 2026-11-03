import { channelUnread, confirmedMute } from "../channels/channel-unread";
import type { Communities } from "../communities/service";
import type { RelaySession } from "../relay/session";

/** A host projection of existing evidence, never a count or a new read owner. */
export function bindUnreadIndicator(
  communities: Communities,
  project: (unread: boolean) => void,
) {
  let closed = false;
  let session: RelaySession | undefined;
  let identity = "";
  let previous: boolean | undefined;
  let detach = () => {};
  const channels = new Map<string, () => void>();
  // DMs and Solo chats keep unread emphasis when muted, as in the sidebar.
  const mutable = new Set<string>();
  const publish = (unread: boolean) => {
    if (unread === previous) return;
    previous = unread;
    project(unread);
  };
  const clear = () => {
    detach();
    detach = () => {};
    for (const stop of channels.values()) stop();
    channels.clear();
    mutable.clear();
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
    const valid = () => !closed && session === owned && identity === next;
    const changed = () => {
      if (!valid()) return;
      const preferences = owned.sidebarPreferences.snapshot();
      publish(
        [...channels.keys()].some((channelId) =>
          channelUnread(
            owned.unread.snapshot({ kind: "channel", channelId }),
            mutable.has(channelId) && confirmedMute(preferences, channelId),
          ),
        ),
      );
    };
    const roster = () => {
      if (!valid()) return;
      const accessible = owned.channels
        .list()
        .channels.filter(
          (channel) =>
            !channel.huddle &&
            !channel.metadataPending &&
            channel.members?.includes(viewer),
        );
      const ids = new Set(accessible.map((channel) => channel.id));
      mutable.clear();
      for (const channel of accessible)
        if (channel.channelType !== "dm" && channel.channelType !== "solo")
          mutable.add(channel.id);
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
    const stopList = owned.channels.subscribeList(roster);
    const stopPreferences = owned.sidebarPreferences.subscribe(changed);
    detach = () => {
      stopList();
      stopPreferences();
    };
    roster();
  };
  const stop = communities.subscribe(update);
  const stopRelay = communities.relay.subscribe(update);
  update();
  return () => {
    if (closed) return;
    closed = true;
    stop();
    stopRelay();
    clear();
    session = undefined;
    publish(false);
  };
}
