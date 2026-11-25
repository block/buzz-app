import { useRef, useState, type ReactElement } from "react";
import {
  useChannelMenuActions,
  type ChannelMenuSurface,
} from "../../features/channel-navigation/ChannelNavigationState";
import { MessageActionBar } from "../../features/messages/MessageActionBar";
import { messageLink } from "../../features/messages/message-copy";
import type { ChannelSummary } from "../../features/relay/contracts";
import { EnvelopeOpenIcon } from "../../shared/design-system/icons";
import {
  ContextMenuRoot,
  ContextMenuTrigger,
  MenuIcon,
  MenuItem,
  MenuPopup,
} from "../../shared/design-system/ui/Menu";
import { useToastNotification } from "../../shared/design-system/ui/Toast";

/** The message a thread row shows, which its menu acts on. */
export type ActivityRowMessage = {
  channelId: string;
  messageId: string;
  threadRootId: string;
  text: string;
};

/** A card row's right-click menu. A thread row has the menu of the message it
 * shows; any other row has its conversation's sidebar row menu. */
export function ActivityRowMenu({
  children,
  channel,
  message,
  onOpen,
  onRead,
}: {
  /** The row's list item, which the menu opens on. */
  children: ReactElement;
  channel: ChannelSummary | undefined;
  message: ActivityRowMessage | undefined;
  onOpen(): void;
  /** Absent unless the row is unread and can be marked read. */
  onRead: (() => void) | undefined;
}) {
  if (message)
    return (
      <MessageActionBar
        messageId={message.messageId}
        copyText={() => message.text}
        link={messageLink(message)}
        onReply={onOpen}
        leadingItems={
          onRead && (
            <MenuItem onClick={onRead}>
              <MenuIcon>
                <EnvelopeOpenIcon />
              </MenuIcon>
              Mark as read
            </MenuItem>
          )
        }
      >
        {children}
      </MessageActionBar>
    );
  return channel ? (
    <ConversationRowMenu channel={channel}>{children}</ConversationRowMenu>
  ) : (
    children
  );
}

/** The sidebar publishes its row actions; this menu only hosts them. */
function ConversationRowMenu({
  children,
  channel,
}: {
  children: ReactElement;
  channel: ChannelSummary;
}) {
  const menuActions = useChannelMenuActions();
  const notify = useToastNotification();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const row = useRef<HTMLDivElement | null>(null);
  const finalFocus = useRef<(() => HTMLElement | false) | undefined>(undefined);
  const focusRow = () =>
    row.current?.querySelector<HTMLElement>("button") ?? false;
  const surface: ChannelMenuSurface = {
    close: (focus) => {
      finalFocus.current = focus;
      setOpen(false);
    },
    focus: () => {
      const button = focusRow() || undefined;
      if (button?.isConnected) button.focus({ preventScroll: true });
    },
    pending,
    runRead: async (action) => {
      setPending(true);
      try {
        await action();
        setOpen(false);
      } catch {
        notify("Couldn't change the read state", "error");
      } finally {
        setPending(false);
      }
    },
    complete: true,
  };
  const actions = open ? menuActions?.(channel, surface) : undefined;
  return (
    <ContextMenuRoot
      open={open}
      // Without the sidebar there is no row menu to host.
      disabled={!menuActions}
      onOpenChange={(next) => {
        if (next) finalFocus.current = undefined;
        setOpen(next);
      }}
    >
      <ContextMenuTrigger
        render={children}
        ref={row}
        onKeyDown={(event) => {
          if (
            event.key === "ContextMenu" ||
            (event.shiftKey && event.key === "F10")
          ) {
            event.preventDefault();
            setOpen(true);
          }
        }}
      />
      <MenuPopup
        size="compact"
        aria-label={`Actions for ${channel.name}`}
        finalFocus={() =>
          finalFocus.current ? finalFocus.current() : focusRow()
        }
      >
        {actions}
      </MenuPopup>
    </ContextMenuRoot>
  );
}
