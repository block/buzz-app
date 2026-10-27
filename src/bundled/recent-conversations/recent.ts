import type { RelaySession } from "../../features/relay/session";
import { ownSolo } from "../../features/solo/labels";

/** A conversation's newest signal; Team rows open at the message that listed them. */
export type Recent = Readonly<{
  channelId: string;
  at: number;
  messageId?: string;
  rootId?: string;
}>;

/** Solo chats and DMs by their latest activity, as their lists order them,
 * and Team stream channels by their newest mention or followed-thread reply
 * (the evidence behind the sidebar's attention dots), read or unread; newest
 * first. */
export function recentConversations(session: RelaySession): readonly Recent[] {
  const recent: Recent[] = [];
  const streams = new Set<string>();
  for (const channel of session.channels.list().channels) {
    if (channel.archived) continue;
    const at = channel.lastActivityAt ?? channel.updatedAt;
    if (channel.channelType === "solo") {
      if (
        at !== undefined &&
        (!channel.readOnly || ownSolo(channel, session.viewer))
      )
        recent.push({ channelId: channel.id, at });
    } else if (channel.huddle || channel.metadataPending) continue;
    else if (channel.channelType === "dm") {
      // As the Direct messages list, which keeps hidden DMs.
      if (at !== undefined) recent.push({ channelId: channel.id, at });
    } else if (!channel.hidden && channel.channelType !== "forum")
      streams.add(channel.id);
  }
  // Inbox items are already sorted newest first.
  for (const item of session.unread.inbox().items)
    if (streams.delete(item.channelId))
      recent.push({
        channelId: item.channelId,
        at: item.createdAt,
        messageId: item.messageId,
        ...(item.rootId && { rootId: item.rootId }),
      });
  return recent.sort(
    (a, b) => b.at - a.at || a.channelId.localeCompare(b.channelId),
  );
}

/** A stable snapshot of `recentConversations` IDs for the sidebar. */
export function recentIds(session: RelaySession) {
  let ids: readonly string[] = [];
  return {
    snapshot() {
      const next = recentConversations(session).map(
        ({ channelId }) => channelId,
      );
      if (next.length !== ids.length || next.some((id, i) => id !== ids[i]))
        ids = next;
      return ids;
    },
    subscribe(listener: () => void) {
      // Inbox's addressed history keeps older, already-read mentions listed.
      // Like Inbox, it waits for current membership.
      const load = () => {
        if (session.channels.list().status === "ready")
          void session.inboxFeed.ensure();
      };
      load();
      const stops = [
        session.unread.subscribeInbox(listener),
        session.channels.subscribeList(() => {
          load();
          listener();
        }),
      ];
      return () => {
        for (const stop of stops) stop();
      };
    },
  };
}

/** The entry `step` away from `current` among the first `limit`, wrapping;
 * from outside them, the first going down or the last going up. */
export function stepRecent(
  recent: readonly Recent[],
  current: string | undefined,
  limit: number,
  step: 1 | -1,
) {
  const shown = recent.slice(0, limit);
  const index = shown.findIndex(({ channelId }) => channelId === current);
  const from = index < 0 ? (step > 0 ? -1 : 0) : index;
  return shown[(from + step + shown.length) % shown.length];
}
