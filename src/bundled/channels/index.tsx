import { MenuItem, MenuIcon } from "../../shared/design-system/ui/Menu";
import { bindDmMoves } from "../../features/dm-moves/coordinator";
import { nativeMoveAgentHost } from "../../features/dm-moves/native";
import {
  DmMoveMessage,
  canConvertDm,
  openDmMove,
} from "../../features/dm-moves/DmMove";
import { StartLinkedChat, canStartLinkedChat } from "./StartLinkedChat";
import { ChannelCompletion } from "./ChannelCompletion";
import { channelQuery } from "./channel-query";
import { isChannelRoute } from "../../features/channel-navigation/routes";
import type { PluginModule } from "../../plugins/api";
import { ChannelsPage } from "./ChannelsPage";
import { PageTabs } from "./PageTabs";
import { registerCanvas } from "./canvas-panel";
import { ChannelTemplateSettings } from "./ChannelTemplateSettings";
import {
  ChatCircleIcon,
  CopyIcon,
  MessageReplyIcon,
} from "../../shared/design-system/icons";
import { isApplePlatform } from "../../features/shortcuts/format";
import type { ArchiveShortcut, ReadShortcut } from "./ChannelsPage";
import {
  conversationRows,
  inTerminal,
  stepConversation,
} from "./conversation-rows";
export const inject = [
  "pages",
  "relay",
  "panels",
  "conversation",
  "navigation",
  "settingsCards",
  "agents",
  "shortcuts",
  "communityReader",
  "adminAccess",
];
export const apply: PluginModule["apply"] = (ctx) => {
  registerCanvas(ctx);
  ctx.conversation.registerCompletion({
    id: "channel-typeahead",
    title: "Channel",
    match: ({ text, start }) => channelQuery(text, start),
    component: ChannelCompletion,
  });
  const extensions = ctx.conversation;
  extensions.registerTabs((props) => (
    <PageTabs {...props} host={ctx} extensions={extensions} />
  ));
  const relay = ctx.relay;
  const navigator = ctx.navigation;
  ctx.effect(() => bindDmMoves(relay, nativeMoveAgentHost()));
  ctx.conversation.registerMessage({
    id: "dm-move-request",
    title: "Convert DM to thread",
    matches: (message) => !!message.dmMove,
    component: ({ message }) => (
      <DmMoveMessage relay={relay} navigation={navigator} message={message} />
    ),
  });
  ctx.conversation.registerMessageAction({
    id: "dm-move-from-message",
    title: "Convert to thread from here",
    placement: "menu",
    icon: () => <MessageReplyIcon size={16} aria-hidden="true" />,
    matches: (message, session) =>
      !message.dmMove &&
      !message.threadRootId &&
      canConvertDm(session, message.channelId),
    component: ({ message, session, close }) => (
      <DmMoveFromHere
        message={message}
        session={session}
        navigation={navigator}
        close={close}
      />
    ),
  });
  ctx.conversation.registerMessageAction({
    id: "start-solo-chat",
    title: "Start Solo chat",
    placement: "menu",
    icon: () => <ChatCircleIcon size={16} aria-hidden="true" />,
    matches: (message, session) =>
      canStartLinkedChat(session, message.channelId) &&
      (!message.delivery || ["accepted", "seen"].includes(message.delivery)),
    component: ({ message, session }) => (
      <StartLinkedChat
        session={session}
        navigation={navigator}
        channelId={message.channelId}
        message={message}
      />
    ),
  });
  const panels = ctx.panels;
  const archive: ArchiveShortcut = {};
  ctx.shortcuts.register({
    id: "archive-chat",
    title: "Archive chat",
    // Apple Mail's Archive. Elsewhere Ctrl is Mod, and Ctrl+Shift+A opens Inbox unread.
    binding: isApplePlatform(globalThis.navigator?.platform ?? "")
      ? { key: "a", mod: true, ctrl: true }
      : { key: "e", mod: true, shift: true },
    order: 20,
    allowInEditable: true,
    when: () => !!archive.current?.available(),
    run: () => archive.current?.run(),
  });
  // Slack's sidebar stepping. Terminals keep Option+Arrow, and stepping is
  // unavailable (the key is left alone) while the sidebar renders no rows.
  const stepping = [
    ["previous-conversation", "Previous conversation", "ArrowUp", false, 30],
    ["next-conversation", "Next conversation", "ArrowDown", false, 31],
    [
      "previous-unread-conversation",
      "Previous unread conversation",
      "ArrowUp",
      true,
      32,
    ],
    [
      "next-unread-conversation",
      "Next unread conversation",
      "ArrowDown",
      true,
      33,
    ],
  ] as const;
  for (const [id, title, key, unreadOnly, order] of stepping)
    ctx.shortcuts.register({
      id,
      title,
      binding: { key, alt: true, shift: unreadOnly },
      order,
      allowInEditable: true,
      when: () => !inTerminal() && conversationRows().length > 0,
      run: () =>
        stepConversation(key === "ArrowUp" ? "previous" : "next", unreadOnly),
    });
  const read: ReadShortcut = {};
  ctx.shortcuts.register({
    id: "mark-read",
    title: "Mark conversation as read",
    binding: { key: "Escape" },
    order: 40,
    allowInEditable: true,
    // Escape in a terminal belongs to its shell.
    when: () => !inTerminal() && !!read.current?.available(),
    run: () => read.current?.run(),
  });
  const agents = ctx.agents;
  const membership = ctx.adminAccess.membership;
  ctx.settingsCards.register({
    id: "templates",
    title: "Channel templates",
    group: "App",
    icon: CopyIcon,
    component: ({ active }) => (
      <ChannelTemplateSettings agents={agents} active={active} />
    ),
  });
  ctx.pages.register({
    id: "channels",
    title: "Channels",
    primary: true,
    placement: "dock",
    layout: "workspace",
    companion: true,
    handlesNavigation: true,
    route: { version: 1, validate: isChannelRoute },
    component: ({ companion, navigation }) => (
      <ChannelsPage
        chatMenus={ctx.conversation.chatMenus}
        navigation={navigation}
        navigator={navigator}
        extensions={extensions}
        relay={relay}
        panels={panels}
        archive={archive}
        read={read}
        companion={companion}
        agents={agents}
        communities={ctx.communityReader}
        membership={membership}
      />
    ),
  });
};

function DmMoveFromHere({
  message,
  session,
  navigation,
  close,
}: {
  message: import("../../features/relay/contracts").ChannelMessage;
  session: import("../../features/relay/session").RelaySession;
  navigation: import("../../features/navigation/controller").Navigation;
  close(): void;
}) {
  return (
    <MenuItem
      onClick={() => {
        close();
        openDmMove(navigation, session, message.channelId, message.id);
      }}
    >
      <MenuIcon>
        <MessageReplyIcon size={16} aria-hidden="true" />
      </MenuIcon>
      Convert to thread from here
    </MenuItem>
  );
}
