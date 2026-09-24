import { memo } from "react";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import type { ChannelSummary, Profile } from "../../features/relay/contracts";
import type { RelaySession } from "../../features/relay/session";
import { ChatCircleIcon } from "../../shared/design-system/icons/index";
import { channelIcon } from "../../features/channels/channel-icon";
import { ChannelActivityPopover } from "./ChannelActivityPopover";
import { ChannelSidebarRow } from "./ChannelSidebarRow";
import { UnreadBadge } from "./UnreadBadge";
import styles from "./Channels.module.css";

const noSessions: readonly ChannelSummary[] = [];

// Own the connected row inside the memo boundary. Selecting another channel
// must not rebuild every unchanged row's controls and subscriptions.
export const ChannelSidebarItem = memo(function ChannelSidebarItem({
  channel,
  profile,
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
  onHideDm,
}: {
  channel: ChannelSummary;
  profile?: Profile | undefined;
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
  onHideDm?: (id: string) => void;
}) {
  const Icon =
    channel.channelType === "dm" ? ChatCircleIcon : channelIcon(channel);
  return (
    <ChannelSidebarRow
      channel={channel}
      icon={
        channel.channelType === "dm" && channel.participants?.length === 1 ? (
          <Avatar
            src={
              profile?.picture
                ? session.media(profile.picture, "small")
                : undefined
            }
            alt=""
            fallback={channel.name}
            size="small"
            shape={profile?.isAgent ? "squircle" : "circle"}
          />
        ) : channel.channelType === "dm" &&
          (channel.participants?.length ?? 0) > 1 ? (
          <span
            className={styles.dmCount}
            title={`${channel.participants?.length} other participants`}
            aria-hidden="true"
          >
            {channel.participants?.length}
          </span>
        ) : (
          <Icon size={17} />
        )
      }
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
      {...(onHideDm ? { onHideDm } : {})}
    />
  );
});
