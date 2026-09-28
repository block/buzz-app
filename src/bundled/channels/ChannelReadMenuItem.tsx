import { useCallback, useMemo, useSyncExternalStore } from "react";
import type { UnreadCapability } from "../../features/relay/unread";
import {
  EnvelopeIcon,
  EnvelopeOpenIcon,
} from "../../shared/design-system/icons";
import { MenuIcon, MenuItem } from "../../shared/design-system/ui/Menu";

/** The menu portal mounts this subscription only while its popup is mounted. */
export function ChannelReadMenuItem({
  unread,
  channelId,
  pending,
  run,
}: {
  unread: Pick<
    UnreadCapability,
    "snapshot" | "subscribe" | "markChannelRead" | "markUnreadLocal"
  >;
  channelId: string;
  pending: boolean;
  run: (action: () => Promise<unknown>) => Promise<void>;
}) {
  const target = useMemo(
    () => ({ kind: "channel" as const, channelId }),
    [channelId],
  );
  const subscribe = useCallback(
    (listener: () => void) => unread.subscribe(target, listener),
    [unread, target],
  );
  const get = useCallback(() => unread.snapshot(target), [unread, target]);
  const snapshot = useSyncExternalStore(subscribe, get, get);
  const hasUnread =
    snapshot.manual !== "none" || (snapshot.observedCount ?? 0) > 0;
  return (
    <MenuItem
      closeOnClick={false}
      disabled={pending}
      title={hasUnread ? undefined : "Mark unread on this device only"}
      onClick={() =>
        void run(() =>
          hasUnread
            ? unread.markChannelRead(channelId)
            : unread.markUnreadLocal(target),
        )
      }
    >
      <MenuIcon>
        {hasUnread ? (
          <EnvelopeOpenIcon size={14} />
        ) : (
          <EnvelopeIcon size={14} />
        )}
      </MenuIcon>
      {hasUnread ? "Mark as Read" : "Mark as Unread"}
    </MenuItem>
  );
}
