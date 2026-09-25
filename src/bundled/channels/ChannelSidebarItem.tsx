import { memo } from "react";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { ContextMenuTrigger } from "../../shared/design-system/ui/Menu";
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
  menuEnabled,
  sectionKey,
  onOpenMenu,
}: {
  channel: ChannelSummary;
  profile?: Profile | undefined;
  session: RelaySession;
  working: boolean;
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
  menuEnabled?: boolean;
  sectionKey?: string | undefined;
  onOpenMenu?: (
    channel: ChannelSummary,
    sectionKey: string,
    anchor?: HTMLElement,
  ) => void;
}) {
  const Icon =
    channel.channelType === "dm" ? ChatCircleIcon : channelIcon(channel);
  return (
    <ChannelSidebarRow
      channel={channel}
      dmVisualSpacing={channel.channelType === "dm"}
      icon={
        channel.channelType === "dm" && channel.participants?.length === 1 ? (
          <span className={styles.dmAvatar} data-dm-identity="">
            <Avatar
              src={
                profile?.picture
                  ? session.media(profile.picture, "small")
                  : undefined
              }
              alt=""
              fallback={channel.name}
              size="fill"
              shape={profile?.isAgent ? "squircle" : "circle"}
            />
          </span>
        ) : channel.channelType === "dm" &&
          (channel.participants?.length ?? 0) > 1 ? (
          <span
            className={styles.dmCount}
            data-dm-identity=""
            data-dm-participant-count=""
            title={`${channel.participants?.length} other participants`}
            aria-hidden="true"
          >
            {channel.participants?.length}
          </span>
        ) : (
          <Icon size={16} />
        )
      }
      badge={
        <span
          className={styles.indicatorStack}
          data-channel-indicators=""
          style={{ display: "inline-grid" }}
        >
          <span style={{ display: "grid", gridArea: "1 / 1" }}>
            <UnreadBadge
              session={session}
              channelId={channel.id}
              dm={channel.channelType === "dm"}
            />
          </span>
          {working && (
            <span
              className={styles.working}
              data-channel-working=""
              data-indicator-layer="working"
              role="img"
              aria-label="Agent working"
              title="Agent working in this channel"
              style={{ display: "block", gridArea: "1 / 1", zIndex: 1 }}
            />
          )}
        </span>
      }
      wrapSelect={(trigger) => {
        const activity = (
          <ChannelActivityPopover
            session={session}
            channelId={channel.id}
            channelName={channel.name}
            onOpenThread={(item) => onOpenThread(item.channelId, item.rootId)}
            trigger={trigger}
          />
        );
        // Keep popup semantics on separate DOM nodes: activity owns the button,
        // the context menu wraps only its select surface, not the child sessions.
        return menuEnabled ? (
          <ContextMenuTrigger
            render={<div />}
            onKeyDown={(event) => {
              if (
                event.key === "ContextMenu" ||
                (event.shiftKey && event.key === "F10")
              ) {
                event.preventDefault();
                if (sectionKey)
                  onOpenMenu?.(channel, sectionKey, event.currentTarget);
              }
            }}
          >
            {activity}
          </ContextMenuTrigger>
        ) : (
          activity
        );
      }}
      selected={selected}
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
