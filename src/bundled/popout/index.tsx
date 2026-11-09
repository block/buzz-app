import { isTauri } from "@tauri-apps/api/core";
import { useEffect, useSyncExternalStore } from "react";
import { buzzLinkTarget } from "../../features/navigation/buzz-links";
import type { PluginModule } from "../../plugins/api";
import {
  createPopoutWindows,
  type PopoutWindows,
} from "../../features/popout/window";
import type { ChannelMessage } from "../../features/relay/contracts";
import { messageActionRequests } from "../../features/messages/action-requests";
import { ArrowSquareOutIcon } from "../../shared/design-system/icons";
import { MenuIcon, MenuItem } from "../../shared/design-system/ui/Menu";
import { useToastNotification } from "../../shared/design-system/ui/Toast";

export const inject = [
  "relay",
  "conversation",
  "navigation",
  "agents",
  "communityReader",
  "panels",
];

/** The thread a message belongs to, when it has one to pop out. */
export function popoutThreadRoot(message: ChannelMessage) {
  if (message.delivery && !["accepted", "seen"].includes(message.delivery))
    return undefined;
  if (message.threadRootId) return message.threadRootId;
  return message.replyCount > 0 ? message.id : undefined;
}

/** Owner notices reach the host toast stack once, whichever composer mounts first. */
function PopoutNotices({ windows }: { windows: PopoutWindows }) {
  const notify = useToastNotification();
  const notices = useSyncExternalStore(
    windows.notices.subscribe,
    windows.notices.snapshot,
  );
  useEffect(() => {
    for (const notice of notices)
      if (windows.notices.claim(notice.id)) notify(notice.text, "info");
  }, [notices, windows, notify]);
  return null;
}

export const apply: PluginModule["apply"] = (ctx) => {
  if (!isTauri()) return;
  const openLink = (url: string) => {
    const connection = ctx.relay.snapshot();
    if (!connection.viewer || !connection.origin) return false;
    const target = buzzLinkTarget(url, {
      viewer: connection.viewer,
      communityOrigin: connection.origin,
    });
    if (!target) return false;
    void ctx.navigation.open(target);
    return true;
  };
  const messageTarget = (
    target: { channelId: string; threadRootId?: string | undefined },
    messageId: string | undefined,
  ) => {
    const connection = ctx.relay.snapshot();
    if (!connection.viewer || !connection.origin) return null;
    const channel = encodeURIComponent(target.channelId);
    // A conversation frame points at the channel; a thread frame at the
    // message within its thread.
    return buzzLinkTarget(
      messageId
        ? `buzz://message?channel=${channel}&id=${messageId}${target.threadRootId ? `&thread=${target.threadRootId}` : ""}`
        : `buzz://channel/${channel}`,
      { viewer: connection.viewer, communityOrigin: connection.origin },
    );
  };
  const windows = createPopoutWindows(ctx.relay, {
    extensions: ctx.conversation,
    openLink,
    agents: ctx.agents,
    actions: ctx.conversation.actions,
    // Handoff: main shows the message, then that row opens the exact action
    // instance (a dialog action opens; a menu action's menu opens with it).
    // The companion never runs a plugin action itself.
    handoff: (target, messageId, action) => {
      const open = messageTarget(target, messageId);
      const { scope, session } = ctx.relay.snapshot();
      if (!open || !scope) return;
      void ctx.navigation.open(open).then((result) => {
        // The same session, not just the same scope: a replaced session is
        // another conversation and the handoff is dropped.
        if (result.status !== "opened") return;
        const now = ctx.relay.snapshot();
        if (now.scope !== scope || now.session !== session) return;
        messageActionRequests.request({
          session,
          scope,
          channelId: target.channelId,
          messageId,
          key: action.key,
          revision: action.revision,
        });
      });
    },
    // The agent's activity view opens beside the conversation once main
    // shows it, through the existing panel opener with this channel context.
    openActivity: (activityTarget, target) => {
      const open = messageTarget(target, target.threadRootId);
      const { scope, session } = ctx.relay.snapshot();
      if (!open || !scope) return;
      void ctx.navigation.open(open).then((result) => {
        // Only a navigation that opened, from the same session it started
        // in, continues into the panel; a failure or a replacement does not.
        if (result.status !== "opened") return;
        const now = ctx.relay.snapshot();
        if (now.scope !== scope || now.session !== session) return;
        ctx.panels.requestOpen({
          target: activityTarget,
          channelId: target.channelId,
          ...(target.threadRootId ? { rootId: target.threadRootId } : {}),
        });
      });
    },
  });
  ctx.conversation.registerAccessory({
    id: "popout-notices",
    title: "Pop-out window notices",
    component: () => <PopoutNotices windows={windows} />,
  });
  ctx.conversation.registerMessageAction({
    id: "open-thread-window",
    title: "Open thread in new window",
    placement: "menu",
    icon: () => <ArrowSquareOutIcon size={16} aria-hidden="true" />,
    matches: (message) => !!popoutThreadRoot(message),
    component: ({ message, close }) => {
      const notify = useToastNotification();
      const root = popoutThreadRoot(message);
      return (
        <MenuItem
          disabled={!root}
          onClick={() => {
            close();
            if (!root) return;
            void windows
              .open({ channelId: message.channelId, threadRootId: root })
              .catch((error: unknown) =>
                notify(
                  error instanceof Error
                    ? error.message
                    : "Couldn’t open the window.",
                  "error",
                ),
              );
          }}
        >
          <MenuIcon>
            <ArrowSquareOutIcon size={16} aria-hidden="true" />
          </MenuIcon>
          Open thread in new window
        </MenuItem>
      );
    },
  });
  // Thread tabs: the tab menu beside Open in channel. Whole conversations
  // follow in S2.
  // A conversation tab's menu, a sidebar row's menu, and ⌘/Ctrl-click on a
  // sidebar row: channels, DMs, Solo chats and threads all open in a window.
  ctx.conversation.registerTabAction({
    id: "open-window",
    title: "Open in new window",
    icon: () => <ArrowSquareOutIcon size={14} aria-hidden="true" />,
    gesture: "modifier-click",
    matches: () => true,
    run: (target) => {
      void windows
        .open({
          channelId: target.channelId,
          ...(target.threadRootId ? { threadRootId: target.threadRootId } : {}),
        })
        .catch(() => {});
    },
  });
  // A voluntary community exit asks before discarding a window's unsent reply.
  const releaseHold = ctx.communityReader.holdExit?.(
    windows.held,
    windows.subscribeHeld,
  );
  ctx.effect(() => async () => {
    releaseHold?.();
    await windows.dispose();
  });
};
