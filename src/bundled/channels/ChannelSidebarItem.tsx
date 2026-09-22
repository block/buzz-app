import { memo } from "react";
import type { ChannelSummary } from "../../features/relay/contracts";
import type { RelaySession } from "../../features/relay/session";
import {
  ChatCircleIcon,
  HashIcon,
  UsersIcon,
} from "../../shared/design-system/icons/index";
import { ChannelActivityPopover } from "./ChannelActivityPopover";
import { ChannelSidebarRow } from "./ChannelSidebarRow";
import { UnreadBadge } from "./UnreadBadge";
import styles from "./Channels.module.css";

const noSessions: readonly ChannelSummary[] = [];

// Own the connected row inside the memo boundary. Selecting another channel
// must not rebuild every unchanged row's controls and subscriptions.
export const ChannelSidebarItem = memo(function ChannelSidebarItem({
  channel,
  session,
  working,
  sessionsEnabled,
  selected,
  collapsed,
  onToggle,
  draft,
  draftSelected,
  sessions = noSessions,
  onSelect,
  onNewSession,
  onOpenThread,
}: {
  channel: ChannelSummary;
  session: RelaySession;
  working: boolean;
  sessionsEnabled: boolean;
  selected: string | undefined;
  collapsed: boolean;
  onToggle: (key: string, open: boolean) => void;
  draft: boolean;
  draftSelected: boolean;
  sessions: readonly ChannelSummary[] | undefined;
  onSelect: (id: string) => void;
  onNewSession: (id: string) => void;
  onOpenThread: (channelId: string, rootId: string) => void;
}) {
  const Icon =
    channel.channelType === "dm"
      ? (channel.participants?.length ?? 0) > 1
        ? UsersIcon
        : ChatCircleIcon
      : HashIcon;
  return (
    <ChannelSidebarRow
      channel={channel}
      icon={<Icon size={17} />}
      badge={
        <>
          {working && (
            <span
              className={styles.working}
              role="img"
              aria-label="Agent working"
              title="Agent working in this channel"
            />
          )}
          <UnreadBadge
            session={session}
            channelId={channel.id}
            dm={channel.channelType === "dm"}
          />
        </>
      }
      wrapSelect={(trigger) => (
        <ChannelActivityPopover
          session={session}
          channelId={channel.id}
          channelName={channel.name}
          onOpenThread={(item) => onOpenThread(item.channelId, item.rootId)}
          trigger={trigger}
        />
      )}
      selected={selected}
      sessionsEnabled={sessionsEnabled}
      collapsed={collapsed}
      onToggle={(open) => onToggle(`session-children:${channel.id}`, open)}
      draft={draft}
      draftSelected={draftSelected}
      sessions={sessions}
      childContent={(child) => (
        <UnreadBadge
          session={session}
          channelId={child.id}
          label={child.name}
        />
      )}
      onPrepare={(id) => session.channels.prepare?.(id)}
      onSelect={onSelect}
      onNewSession={onNewSession}
    />
  );
});
