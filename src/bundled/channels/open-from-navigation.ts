import { matchesConversation } from "../../features/channel-navigation/routes";
import type { Navigation } from "../../features/navigation/controller";
import type { RelayData } from "../../features/relay/service";

/** A channel's open starts from what opens it: the click, key or route that
 * navigates to it (Back and Forward included), or the session that will show
 * it, as after a reload. Never from drawing its pane, which shows whatever
 * state the open has set by then. Navigation and sessions publish before
 * React draws what they changed, so the pane's first commit sees it. */
export function openFromNavigation(navigation: Navigation, relay: RelayData) {
  let opened: Readonly<{ session: unknown; channelId: string }> | undefined;
  const open = () => {
    const { target } = navigation.snapshot().attempt.entry;
    const { session, scope } = relay.snapshot();
    if (
      target.kind !== "conversation" ||
      !scope ||
      !matchesConversation(target, scope, target.channelId) ||
      (opened?.session === session && opened.channelId === target.channelId)
    )
      return;
    opened = { session, channelId: target.channelId };
    session.channels.open?.(target.channelId);
  };
  const stops = [navigation.subscribe(open), relay.subscribe(open)];
  open();
  return () => {
    for (const stop of stops) stop();
  };
}
