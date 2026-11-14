import { useLayoutEffect } from "react";
import type { PluginModule } from "../../plugins/api";
import type { PageNavigation } from "../../features/navigation/service";
import type { RelayData } from "../../features/relay/service";
import { useRelayConnection } from "../../features/relay/react";
import { saveActivityView } from "../../features/conversation/ConversationList";
import { BellIcon } from "../../shared/design-system/icons";
import { EmptyState } from "../../shared/design-system/ui/EmptyState";
import { ConversationListToggle } from "../../features/conversation/ConversationListToggle";
import { NoConversationSelected } from "../../features/conversation/NoConversationSelected";
import { PanelHeader } from "../../shared/design-system/ui/PanelHeader";
import { InboxPreview } from "./InboxPreview";
import styles from "./Inbox.module.css";
import {
  composingOf,
  detailOf,
  inboxRouteTarget,
  isInboxRoute,
  routeOf,
  type InboxRoute,
} from "./route";
export const inject = ["pages", "relay", "navigation", "shortcuts"];
export const apply: PluginModule["apply"] = (ctx) => {
  const relay = ctx.relay;
  const navigator = ctx.navigation;
  // Slack's chords for jumping to a filtered Activity view, including from the composer.
  const open = (
    id: string,
    title: string,
    key: string,
    order: number,
    params: InboxRoute,
  ) =>
    ctx.shortcuts.register({
      id,
      title,
      binding: { key, mod: true, shift: true },
      order,
      allowInEditable: true,
      run: () => {
        void navigator.open(inboxRouteTarget(params));
      },
    });
  open("open-unread", "Open unread in Activity", "a", 20, {
    activity: "all",
    attention: "unread",
  });
  open("open-threads", "Open threads in Activity", "t", 30, {
    activity: "threads",
  });
  open("open-mentions", "Open mentions in Activity", "m", 40, {
    activity: "mentions",
  });
  open("open-dms", "Open DMs in Activity", "k", 50, { activity: "dms" });
  ctx.pages.register({
    id: "inbox",
    title: "Activity",
    layout: "workspace",
    primary: true,
    route: { version: 1, validate: isInboxRoute },
    component: ({ navigation }) => (
      <ActivityAddress relay={relay} navigation={navigation} />
    ),
    preview: ({ close }) => (
      <InboxPreview relay={relay} navigator={navigator} close={close} />
    ),
  });
};

/**
 * Activity is Team's list on All: conversations with the threads, mentions and
 * reactions among them. The shell shows that list for this address; this page
 * sets the view the address names. An address that names a conversation or a
 * new message opens it.
 */
function ActivityAddress({
  relay,
  navigation,
}: {
  relay: RelayData;
  navigation: PageNavigation | undefined;
}) {
  const { status, viewer, scope: partition } = useRelayConnection(relay);
  const signedIn = !!viewer && !!partition?.endsWith(`:${viewer}`);
  // biome-ignore lint/correctness/useExhaustiveDependencies: A visit applies its address once; Back keeps what the list showed.
  useLayoutEffect(() => {
    if (!navigation || navigation.traversal || !viewer || !partition) return;
    if (!signedIn) return;
    const { target } = navigation;
    const scope = {
      viewer,
      communityOrigin: partition.slice(0, -(viewer.length + 1)),
    };
    const detail = detailOf(target);
    if (detail) {
      navigation.resolve({
        version: 1,
        kind: "conversation",
        scope,
        channelId: detail.channelId,
        ...(detail.messageId && { messageId: detail.messageId }),
        ...(detail.threadId && {
          threadRootId: detail.threadId,
          context: "thread" as const,
        }),
      });
      return;
    }
    if (composingOf(target)) {
      navigation.resolve({
        version: 1,
        kind: "page",
        pluginId: "buzz.channels",
        pageId: "channels",
        scope,
        route: { version: 1, params: "compose" },
      });
      return;
    }
    const route = routeOf(target);
    saveActivityView(partition, (view) => {
      const { sender: _, ...rest } = view;
      const from = route?.sender ?? view.sender ?? "everyone";
      const activity = route?.activity ?? "all";
      return {
        ...rest,
        ...(from !== "everyone" && { sender: from }),
        // Direct was DMs and mentions together; Team has no agent views.
        filter:
          activity === "direct"
            ? "dms"
            : activity === "working" || activity === "waiting"
              ? "all"
              : activity,
        ...(route?.attention && { unread: route.attention === "unread" }),
      };
    });
  }, [navigation?.entryId, signedIn]);
  return status === "ready" && signedIn ? (
    <div className={styles.reader}>
      <PanelHeader
        variant="conversation"
        title={null}
        navigation={<ConversationListToggle />}
      />
      <div className={styles.unselected}>
        <NoConversationSelected />
      </div>
    </div>
  ) : (
    <EmptyState
      icon={<BellIcon />}
      title="Choose a community to see your activity"
    />
  );
}
