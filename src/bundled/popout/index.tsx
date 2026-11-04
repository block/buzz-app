import { isTauri } from "@tauri-apps/api/core";
import { useEffect, useSyncExternalStore } from "react";
import { buzzLinkTarget } from "../../features/navigation/buzz-links";
import type { PluginModule } from "../../plugins/api";
import {
  createPopoutWindows,
  type PopoutWindows,
} from "../../features/popout/window";
import type { ChannelMessage } from "../../features/relay/contracts";
import { ArrowSquareOutIcon } from "../../shared/design-system/icons";
import { MenuIcon, MenuItem } from "../../shared/design-system/ui/Menu";
import { useToastNotification } from "../../shared/design-system/ui/Toast";

export const inject = [
  "relay",
  "conversation",
  "navigation",
  "agents",
  "communityReader",
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
  const windows = createPopoutWindows(ctx.relay, {
    extensions: ctx.conversation,
    openLink,
    agents: ctx.agents,
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
  ctx.conversation.registerTabAction({
    id: "open-thread-window",
    title: "Open in new window",
    matches: (target) => !!target.threadRootId,
    run: (target) => {
      if (!target.threadRootId) return;
      void windows
        .open({
          channelId: target.channelId,
          threadRootId: target.threadRootId,
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
