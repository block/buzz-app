import { ChatIconSlot } from "../../features/conversation/ChatIconSlot";
import {
  useCallback,
  useMemo,
  useSyncExternalStore,
  type ComponentProps,
} from "react";
import type { RelaySession } from "../../features/relay/session";
import type { ChannelSummary } from "../../features/relay/contracts";
import type { ReadTarget } from "../../features/relay/read-state-model";
import { ConversationRow } from "../../features/messages/ConversationRow";
import {
  channelUnread,
  useConfirmedMute,
} from "../../bundled/channels/UnreadBadge";
import { ArrowRightIcon } from "../../shared/design-system/icons";
import type { RailEntry } from "./rail-pins";

/** Exact destinations read their own evidence; only channel rows aggregate threads. */
export function useRailUnread(
  session: RelaySession,
  destination: RailEntry["target"],
  channel?: ChannelSummary,
) {
  const target = useMemo<ReadTarget | undefined>(() => {
    if (destination.kind !== "conversation")
      return channel ? { kind: "channel", channelId: channel.id } : undefined;
    const channelId = destination.channelId;
    return destination.threadRootId
      ? { kind: "thread", channelId, rootId: destination.threadRootId }
      : destination.messageId
        ? { kind: "message", channelId, messageId: destination.messageId }
        : { kind: "channel", channelId };
  }, [destination, channel]);
  const subscribe = useCallback(
    (listener: () => void) =>
      target ? session.unread.subscribe(target, listener) : () => {},
    [session, target],
  );
  const get = useCallback(
    () => (target ? session.unread.snapshot(target) : undefined),
    [session, target],
  );
  const snapshot = useSyncExternalStore(subscribe, get, get);
  const subscribeActivity = useCallback(
    (listener: () => void) =>
      target?.kind === "channel"
        ? session.unread.subscribeActivity(target.channelId, listener)
        : () => {},
    [session, target],
  );
  const getActivity = useCallback(
    () =>
      target?.kind === "channel"
        ? session.unread.activity(target.channelId)
        : undefined,
    [session, target],
  );
  const activity = useSyncExternalStore(
    subscribeActivity,
    getActivity,
    getActivity,
  );
  const muted = useConfirmedMute(session, target?.channelId ?? "");
  if (!snapshot) return false;
  return target?.kind === "channel"
    ? channelUnread(snapshot, channel?.channelType === "dm", muted) ||
        !!activity?.items?.some((item) => item.unreadCount > 0)
    : snapshot.manual !== "none" || (snapshot.observedCount ?? 0) > 0;
}

export function RailConversationItem({
  session,
  channel,
  destination,
  avatarOnly = false,
  layout = "navigation",
  preview = null,
  ...props
}: {
  session: RelaySession;
  channel?: ChannelSummary | undefined;
  destination: RailEntry["target"];
  avatarOnly?: boolean;
  layout?: "navigation" | "feed";
  preview?: ComponentProps<typeof ConversationRow>["preview"];
} & Omit<
  ComponentProps<typeof ConversationRow>,
  "layout" | "state" | "time" | "preview"
>) {
  const unread = useRailUnread(session, destination, channel);
  return (
    <ConversationRow
      placeIcon={
        channel?.channelType === "solo" && !avatarOnly ? (
          <ChatIconSlot session={session} channelId={channel.id} />
        ) : undefined
      }
      {...props}
      layout={avatarOnly ? "avatar" : layout}
      time={null}
      preview={preview}
      state={unread ? "unread" : "read"}
      aria-description={unread ? "Unread messages" : undefined}
    />
  );
}

/** Summarize only destinations omitted by the card's current preview. */
export function RailOpenConversations({
  session,
  channels,
  hidden,
  label,
  onClick,
}: {
  session: RelaySession;
  channels: readonly ChannelSummary[];
  hidden: readonly RailEntry[];
  label: string;
  onClick: () => void;
}) {
  // The card lists its hidden rows anew on every render; what they are is
  // their ids, so a rail render keeps these subscriptions.
  const ids = hidden.map((entry) => entry.id).join("\n");
  // biome-ignore lint/correctness/useExhaustiveDependencies: `ids` keys `hidden`.
  const targets = useMemo(
    () =>
      hidden.flatMap(({ target }) => {
        if (target.kind !== "conversation") return [];
        const channel = channels.find((item) => item.id === target.channelId);
        const read: ReadTarget = target.threadRootId
          ? {
              kind: "thread",
              channelId: target.channelId,
              rootId: target.threadRootId,
            }
          : target.messageId
            ? {
                kind: "message",
                channelId: target.channelId,
                messageId: target.messageId,
              }
            : { kind: "channel", channelId: target.channelId };
        return [{ read, channel }];
      }),
    [ids, channels],
  );
  const subscribe = useCallback(
    (listener: () => void) => {
      const stops = targets.flatMap(({ read }) => [
        session.unread.subscribe(read, listener),
        ...(read.kind === "channel"
          ? [session.unread.subscribeActivity(read.channelId, listener)]
          : []),
      ]);
      stops.push(session.sidebarPreferences.subscribe(listener));
      return () =>
        stops.forEach((stop) => {
          stop();
        });
    },
    [session, targets],
  );
  const get = useCallback(() => {
    const preferences = session.sidebarPreferences.snapshot();
    return targets.some(({ read, channel }) => {
      const snapshot = session.unread.snapshot(read);
      if (read.kind !== "channel")
        return snapshot.manual !== "none" || (snapshot.observedCount ?? 0) > 0;
      const muted =
        !preferences.cached &&
        !!preferences.data?.muted.includes(read.channelId);
      return (
        channelUnread(snapshot, channel?.channelType === "dm", muted) ||
        !!session.unread
          .activity(read.channelId)
          .items?.some((item) => item.unreadCount > 0)
      );
    });
  }, [session, targets]);
  const unread = useSyncExternalStore(subscribe, get, get);
  return (
    <ConversationRow
      layout="navigation"
      avatar={<ArrowRightIcon size={18} />}
      place={label}
      time={null}
      preview={null}
      state={unread ? "unread" : "read"}
      aria-label={label}
      aria-description={unread ? "Unread messages" : undefined}
      data-rail-view-more=""
      onClick={onClick}
    />
  );
}
