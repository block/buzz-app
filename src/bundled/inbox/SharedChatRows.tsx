import { useSyncExternalStore } from "react";
import type { Navigation } from "../../features/navigation/controller";
import type { RelayData } from "../../features/relay/service";
import type { RelaySession } from "../../features/relay/session";
import { useChannelList, useRelayConnection } from "../../features/relay/react";
import { conversationTarget } from "../../features/channel-navigation/routes";
import { ownSolo, soloChatLinkName } from "../../features/solo/labels";
import { ChatCircleIcon } from "../../shared/design-system/icons";
import { NavigationItem } from "../../shared/design-system/ui/NavigationItem";

/** Someone else's Solo chats with an unread tag for the viewer, or open now,
 * nested under Inbox. */
export function SharedChatRows({
  relay,
  navigator,
}: {
  relay: RelayData;
  navigator: Navigation;
}) {
  const connection = useRelayConnection(relay);
  return connection.status === "ready" &&
    connection.viewer &&
    connection.scope ? (
    <Rows
      key={`${connection.scope}:${connection.generation}`}
      session={connection.session}
      viewer={connection.viewer}
      scope={connection.scope}
      navigator={navigator}
    />
  ) : null;
}

function Rows({
  session,
  viewer,
  scope,
  navigator,
}: {
  session: RelaySession;
  viewer: string;
  scope: string;
  navigator: Navigation;
}) {
  const list = useChannelList(session.channels);
  const inbox = useSyncExternalStore(
    session.unread.subscribeInbox,
    session.unread.inbox,
  );
  const target = useSyncExternalStore(
    navigator.subscribe,
    () => navigator.snapshot().entry.target,
  );
  const open = target.kind === "conversation" ? target.channelId : undefined;
  // The unread engine gives each shared chat one row, built only from tags.
  const tagged = new Set(
    inbox.items
      .filter((item) => item.unreadCount > 0 || item.manual)
      .map((item) => item.channelId),
  );
  const chats = list.channels.filter(
    (channel) => channel.channelType === "solo" && !ownSolo(channel, viewer),
  );
  // The open chat keeps its row, so reading it never pulls the row away
  // underfoot; it leaves once the viewer moves on.
  return chats
    .filter((channel) => tagged.has(channel.id) || channel.id === open)
    .map((channel) => (
      <NavigationItem
        key={channel.id}
        variant="row"
        inset
        label={soloChatLinkName(channel)}
        title={soloChatLinkName(channel)}
        icon={<ChatCircleIcon size={16} />}
        selected={open === channel.id}
        onClick={() =>
          void navigator.open(conversationTarget(scope, channel.id))
        }
      />
    ));
}
