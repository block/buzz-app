import { useLayoutEffect } from "react";
import type { PluginModule } from "../../plugins/api";
import type { PageNavigation } from "../../features/navigation/service";
import type { OpenTarget } from "../../features/navigation/targets";
import type { RelayData } from "../../features/relay/service";
import { useRelayConnection } from "../../features/relay/react";
import { saveActivityView } from "../../features/conversation/ConversationList";
import { InboxPreview } from "./InboxPreview";
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
 * reactions among them. Its address opens that list on the view it names, and
 * an address that names a conversation opens the conversation.
 */
function ActivityAddress({
  relay,
  navigation,
}: {
  relay: RelayData;
  navigation: PageNavigation | undefined;
}) {
  const { viewer, scope: partition } = useRelayConnection(relay);
  useLayoutEffect(() => {
    if (!navigation) return;
    const { target } = navigation;
    const scope =
      target.kind === "page" && target.scope
        ? target.scope
        : viewer && partition?.endsWith(`:${viewer}`)
          ? {
              viewer,
              communityOrigin: partition.slice(0, -(viewer.length + 1)),
            }
          : undefined;
    const detail = detailOf(target);
    const team = (params?: "compose"): OpenTarget => ({
      version: 1,
      kind: "page",
      pluginId: "buzz.channels",
      pageId: "channels",
      ...(scope && { scope }),
      ...(params && { route: { version: 1, params } }),
    });
    if (detail && scope) {
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
      navigation.resolve(team("compose"));
      return;
    }
    const route = routeOf(target);
    if (scope)
      saveActivityView(`${scope.communityOrigin}:${scope.viewer}`, (view) => {
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
    navigation.resolve(team());
  }, [navigation, viewer, partition]);
  return null;
}
