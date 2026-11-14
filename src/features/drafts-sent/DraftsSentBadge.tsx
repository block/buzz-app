import { ClockIcon } from "../../shared/design-system/icons";
import { useScheduledMessages } from "../messages/useScheduledMessages";
import type { RelayData } from "../relay/service";
import { useChannelList, useRelayConnection } from "../relay/react";
import { CountBadge } from "../../shared/design-system/ui/CountBadge";
import styles from "./DraftsSent.module.css";
import { useDrafts } from "./drafts";
import { listed } from "./scope";

/** Unfinished drafts and queued delivery in the current community. */
export function DraftsSentBadge({ relay }: { relay: RelayData }) {
  const connection = useRelayConnection(relay);
  const session =
    connection.status === "ready" ? connection.session : undefined;
  const drafts = useDrafts(session);
  const { channels } = useChannelList(connection.session.channels);
  const count = session
    ? drafts.entries.filter((entry) =>
        listed(channels.find((channel) => channel.id === entry.channelId)),
      ).length
    : 0;
  const scheduled = useScheduledMessages(session?.scheduledMessages);
  const queued = scheduled.items.filter(
    (item) => item.status !== "sent",
  ).length;
  return count || queued ? (
    <span className={styles.badge}>
      {queued > 0 && (
        <span className={styles.scheduledBadge}>
          <ClockIcon size={14} aria-hidden="true" />
          <CountBadge
            count={queued}
            label={`${queued} scheduled message${queued === 1 ? "" : "s"}`}
          />
        </span>
      )}
      <CountBadge
        count={count}
        label={`${count} draft${count === 1 ? "" : "s"}`}
      />
    </span>
  ) : null;
}
