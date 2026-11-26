import type { SidebarSectionBodyProps } from "../../features/channel-navigation/sidebar-sections-service";
import type { Navigation } from "../../features/navigation/controller";
import { useRelayConnection } from "../../features/relay/react";
import type { RelayData } from "../../features/relay/service";
import { ActivityFeed, type FeedDestination } from "./ActivityFeed";
import { useActivityLayout } from "./activity-layout";
import { inboxRouteTarget } from "./route";

/** Activity in a sidebar card: one list, unread first, then newest first. */
export function ActivityCard({
  relay,
  navigator,
  target,
}: SidebarSectionBodyProps & { relay: RelayData; navigator: Navigation }) {
  const connection = useRelayConnection(relay);
  const layout = useActivityLayout();
  const { viewer, scope } = connection;
  if (
    connection.status !== "ready" ||
    !viewer ||
    !scope?.endsWith(`:${viewer}`)
  )
    return null;
  // The row of the conversation or thread open now shows selected, as its row
  // elsewhere in the sidebar does.
  const isOpen = (destination: FeedDestination) =>
    target.kind === "conversation" &&
    target.channelId === destination.channelId &&
    (target.threadRootId ?? target.inline) === destination.rootId;
  return (
    <ActivityFeed
      key={`${scope}:${connection.generation}`}
      session={connection.session}
      scope={{ viewer, communityOrigin: scope.slice(0, -(viewer.length + 1)) }}
      navigator={navigator}
      isOpen={isOpen}
      unreadFirst
      compact={layout !== "default"}
      previews={layout === "default2"}
      showTime={false}
      // Past the card's 50 rows, the rest are on the Activity page, which
      // stays open to links even when its sidebar entry is hidden.
      onSeeAll={() => void navigator.open(inboxRouteTarget({}))}
    />
  );
}
