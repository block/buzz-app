import { useChannelIdentityNames } from "../../features/identity-names/react";
import { NavigationItem } from "../../shared/design-system/ui/NavigationItem";
import {
  PopoverRoot,
  PopoverTrigger,
  PopoverPopup,
} from "../../shared/design-system/ui/Popover";
import {
  useCallback,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactElement,
} from "react";
import { selectProfiles } from "../../features/relay/profile-selection";
import type { RelaySession } from "../../features/relay/session";
import type { ThreadActivityItem } from "../../features/relay/unread";
import { Avatar } from "../../shared/Avatar";
import styles from "./Channels.module.css";

const elapsed = (createdAt: number) => {
  const seconds = Math.max(0, Math.floor(Date.now() / 1000) - createdAt);
  if (seconds < 60) return "now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
};

function ActivityRow({
  item,
  session,
  onOpen,
}: {
  item: ThreadActivityItem;
  session: RelaySession;
  onOpen(item: ThreadActivityItem): void;
}) {
  const selection = useMemo(
    () => selectProfiles(session.profiles, [item.authorId]),
    [session.profiles, item.authorId],
  );
  const profiles = useSyncExternalStore(
    selection.subscribe,
    selection.snapshot,
    selection.snapshot,
  );
  const profile = profiles.get(item.authorId);
  const resolveName = useChannelIdentityNames(session, item.channelId);
  const name = resolveName(item.authorId, profile?.name ?? "Someone");
  return (
    <div className={styles.activityItem}>
      <NavigationItem
        type="button"
        aria-label={`Open unread thread from ${name}: ${item.preview}`}
        onClick={() => onOpen(item)}
        icon={
          <Avatar
            name={name}
            src={profile?.picture ? session.media(profile.picture) : undefined}
            className={styles.activityAvatar ?? ""}
          />
        }
        label={
          <span className={styles.activityItemBody}>
            <span className={styles.activityItemHeading}>
              <strong>{name}</strong>
              <span className={styles.activityTimestamp}>
                {elapsed(item.createdAt)}
              </span>
            </span>
            <span className={styles.activityItemMeta}>
              Thread
              {item.unreadCount > 1 ? ` · ${item.unreadCount} unread` : ""}
            </span>
            <span className={styles.activityItemPreview}>{item.preview}</span>
          </span>
        }
      />
    </div>
  );
}

export function ChannelActivityPopover({
  session,
  channelId,
  channelName,
  trigger,
  onOpenThread,
}: {
  session: RelaySession;
  channelId: string;
  channelName: string;
  trigger: ReactElement;
  onOpenThread(item: ThreadActivityItem): void;
}) {
  const subscribe = useCallback(
    (listener: () => void) =>
      session.unread.subscribeActivity(channelId, listener),
    [session, channelId],
  );
  const get = useCallback(
    () => session.unread.activity(channelId),
    [session, channelId],
  );
  const snapshot = useSyncExternalStore(subscribe, get, get);
  const items = snapshot.items ?? [];
  const [open, setOpen] = useState(false);
  if (!items.length) return trigger;
  const stale = snapshot.freshness === "stale";
  return (
    <PopoverRoot
      modal={false}
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next)
          void session.profiles
            .ensure(
              [...new Set(items.map(({ authorId }) => authorId))],
              "background",
            )
            .catch(() => {});
      }}
    >
      <PopoverTrigger
        render={trigger}
        openOnHover
        delay={250}
        closeDelay={150}
      />
      <PopoverPopup
        side="right"
        align="start"
        sideOffset={6}
        size="wide"
        padding="list"
        aria-label={`Activity in ${channelName}`}
      >
        {stale && <p className={styles.activityStale}>May be out of date</p>}
        {open && (
          <div className={styles.activityList}>
            {items.map((item) => (
              <ActivityRow
                key={item.rootId}
                item={item}
                session={session}
                onOpen={(selected) => {
                  setOpen(false);
                  onOpenThread(selected);
                }}
              />
            ))}
          </div>
        )}
      </PopoverPopup>
    </PopoverRoot>
  );
}
