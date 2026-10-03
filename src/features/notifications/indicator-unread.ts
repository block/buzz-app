import { hasUnread } from "../relay/unread";
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
  let stopUnread = () => {};
  const publish = (unread: boolean) => {
    if (unread === previous) return;
    previous = unread;
    project(unread);
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
    stopUnread();
    session = owned;
    identity = next;
    publish(false);
    if (!owned) return;
    const valid = () => !closed && session === owned && identity === next;
    const changed = () => {
      if (!valid()) return;
      publish(
        owned.channels.list().channels.some((channel) => {
          const snapshot = owned.unread.snapshot({
            kind: "channel",
            channelId: channel.id,
          });
          return (
            snapshot.manual !== "none" ||
            (snapshot.unreadVisible ?? hasUnread(snapshot.unread))
          );
        }),
      );
    };
    // One subscription covers every channel: the unread owner publishes on any
    // count, mark or access change, and its snapshots already hide lost access.
    stopUnread = owned.unread.subscribeSync(changed);
    changed();
  };
  const stop = communities.subscribe(update);
  const stopRelay = communities.relay.subscribe(update);
  update();
  return () => {
    if (closed) return;
    closed = true;
    stop();
    stopRelay();
    stopUnread();
    session = undefined;
    publish(false);
  };
}
