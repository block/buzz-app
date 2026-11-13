import type { RelayData } from "../../features/relay/service";
import { useChannelList, useRelayConnection } from "../../features/relay/react";
import { CountBadge } from "../../shared/design-system/ui/CountBadge";
import { useReviewChannel, useSubmissionUpdates } from "./submission-updates";

export function ReviewUpdatesBadge({ relay }: { relay: RelayData }) {
  const connection = useRelayConnection(relay);
  const session = connection.session;
  const [channel] = useReviewChannel(session.scope);
  const list = useChannelList(session.channels);
  const selected = list.channels.find((item) => item.id === channel);
  const readable =
    connection.status === "ready" &&
    !!selected &&
    !selected.cached &&
    !selected.metadataCached &&
    !selected.metadataPending &&
    !selected.pending &&
    !selected.archived &&
    !selected.huddle &&
    (selected.channelType === "stream" || selected.channelType === "forum");
  const updates = useSubmissionUpdates(session, channel, readable);
  const count =
    readable && !updates.error
      ? updates.rows.filter(updates.store.unread).length
      : 0;
  return (
    <CountBadge
      count={count}
      label={`${count} updated pull requests in ${selected?.name ?? "review channel"}`}
    />
  );
}
