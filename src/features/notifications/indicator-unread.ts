import type { Communities } from "../communities/service";
import type { RelaySession } from "../relay/session";
import { communityDestination } from "../communities/destination";
import { observeCommunityUnread, type UnreadGates } from "./community-unread";

import type { BadgeActivity } from "./preferences";

/** Notification gates: only conversations they allow light the indicator. */
export type IndicatorGates = UnreadGates & { badgeActivity?(): BadgeActivity };

/** A host projection of the selected community's existing evidence, without
 * adding relay reads. */
export function bindUnreadIndicator(
  communities: Communities,
  project: (unread: boolean, count?: number) => void,
  gates?: IndicatorGates,
) {
  let closed = false;
  let session: RelaySession | undefined;
  let identity = "";
  let previous: boolean | undefined;
  let stopObserving = () => {};
  let previousCount = 0;
  const publish = (unread: boolean, count = 0) => {
    if (unread === previous && count === previousCount) return;
    previous = unread;
    previousCount = count;
    if (count) project(unread, count);
    else project(unread);
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
    stopObserving();
    stopObserving = () => {};
    session = owned;
    identity = next;
    publish(false);
    if (!owned) return;
    stopObserving = observeCommunityUnread(
      owned,
      client.viewer as string,
      communityDestination(client.selected as string).url,
      (state) => publish(!!state?.unread, state?.attention),
      gates,
      false,
      () => gates?.badgeActivity?.() ?? "all",
    );
  };
  const stop = communities.subscribe(update);
  const stopRelay = communities.relay.subscribe(update);
  update();
  return () => {
    if (closed) return;
    closed = true;
    stop();
    stopRelay();
    stopObserving();
    session = undefined;
    publish(false);
  };
}
