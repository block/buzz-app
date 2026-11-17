import { useRef, useState, type ReactElement } from "react";
import type { RelaySession } from "../../features/relay/session";
import {
  conversationIndex,
  type ConversationFilter,
} from "../../features/conversation/conversation-index";
import type { ReadTarget } from "../../features/relay/read-state-model";
import {
  ContextMenuRoot,
  ContextMenuTrigger,
  MenuPopup,
  MenuItem,
  MenuIcon,
} from "../../shared/design-system/ui/Menu";
import {
  EnvelopeIcon,
  EnvelopeOpenIcon,
} from "../../shared/design-system/icons";
import { useToastNotification } from "../../shared/design-system/ui/Toast";

/** A shortcut changes only the conversations or events represented by its view. */
export function TeamViewMenu({
  session,
  filter,
  children,
}: {
  session: RelaySession;
  filter: ConversationFilter;
  children: ReactElement;
}) {
  const [open, setOpen] = useState(false);
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement>();
  const [pending, setPending] = useState(false);
  const [hasUnread, setHasUnread] = useState(false);
  const running = useRef(false);
  const notify = useToastNotification();
  const changeOpen = (next: boolean) => {
    if (next)
      setHasUnread(
        conversationIndex(session).keys({ filter, unread: true, home: "team" })
          .length > 0,
      );
    setOpen(next);
  };
  const run = async (unread: boolean) => {
    if (running.current) return;
    running.current = true;
    setPending(true);
    try {
      const index = conversationIndex(session);
      // Snapshot before mutation: marking read removes entries from unread views.
      const targets: ReadTarget[] = index
        .keys({ filter, unread: !unread, home: "team" })
        .flatMap((key): ReadTarget[] => {
          if (key.startsWith("c:"))
            return [{ kind: "channel", channelId: key.slice(2) }];
          if (!key.startsWith("e:")) return []; // Reactions have no unread state.
          const event = index.event(key.slice(2));
          if (!event) return [];
          return [
            event.rootId
              ? {
                  kind: "thread",
                  channelId: event.channelId,
                  rootId: event.rootId,
                }
              : {
                  kind: "message",
                  channelId: event.channelId,
                  messageId: event.messageId,
                },
          ];
        });
      const channels = new Set(
        targets
          .filter((target) => target.kind === "channel")
          .map((target) => target.channelId),
      );
      const unique = new Map(
        targets
          .filter(
            (target) =>
              target.kind === "channel" || !channels.has(target.channelId),
          )
          .map((target) => [JSON.stringify(target), target]),
      );
      let failed = 0;
      // Serialize saves through the existing read-state owner; don't burst writes.
      for (const target of unique.values()) {
        try {
          if (unread) await session.unread.markUnreadLocal(target);
          else if (target.kind === "channel")
            await session.unread.markChannelRead(target.channelId);
          else if (target.kind === "thread")
            await session.unread.prepareThreadRead(
              target.channelId,
              target.rootId,
            )();
          else
            await session.unread.markMessageRead(
              target.channelId,
              target.messageId,
            );
        } catch {
          failed++;
        }
      }
      if (failed)
        notify(
          `Couldn't update ${failed} item${failed === 1 ? "" : "s"}. Try again.`,
          "error",
        );
      else
        notify(
          unread ? "Marked as unread on this device" : "Marked as read",
          "success",
        );
      setOpen(false);
    } catch {
      notify("Couldn't update read status. Try again.", "error");
    } finally {
      running.current = false;
      setPending(false);
    }
  };
  return (
    <ContextMenuRoot open={open} onOpenChange={changeOpen}>
      <ContextMenuTrigger
        render={children}
        onContextMenu={() => setMenuAnchor(undefined)}
        onTouchStart={() => setMenuAnchor(undefined)}
        onKeyDown={(event) => {
          if (
            event.key === "ContextMenu" ||
            (event.shiftKey && event.key === "F10")
          ) {
            event.preventDefault();
            setMenuAnchor(event.currentTarget);
            changeOpen(true);
          }
        }}
      />
      <MenuPopup anchor={menuAnchor}>
        <MenuItem
          disabled={
            pending ||
            (hasUnread && session.unread.sync().capability !== "frontier-sync")
          }
          closeOnClick={false}
          title={hasUnread ? undefined : "Mark unread on this device only"}
          onClick={() => void run(!hasUnread)}
        >
          <MenuIcon>
            {hasUnread ? (
              <EnvelopeOpenIcon size={14} />
            ) : (
              <EnvelopeIcon size={14} />
            )}
          </MenuIcon>
          {hasUnread ? "Mark as read" : "Mark as unread"}
        </MenuItem>
      </MenuPopup>
    </ContextMenuRoot>
  );
}
