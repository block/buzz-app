import type { ChannelMessage } from "../relay/contracts";
import { safeMessageUrl } from "../relay/message-content";
import { MediaAttachment } from "./MediaAttachment";
import styles from "./Messages.module.css";

/** A details message's videos in its reader: the player its brief shows in the
 * chat, so playback follows the message as it opens and closes. */
export function DetailsVideos({
  row,
  media,
  onOpenMediaReview,
}: {
  row: ChannelMessage;
  media(url: string): string | undefined;
  onOpenMediaReview?:
    | ((
        messageId: string,
        attachment: ChannelMessage["attachments"][number],
        seconds: number,
        hasComments?: boolean,
        attachments?: ChannelMessage["attachments"],
      ) => void)
    | undefined;
}) {
  // The brief's players name their video by its safe URL; so do these.
  const videos = row.attachments.flatMap((attachment) => {
    const url = attachment.kind === "video" && safeMessageUrl(attachment.url);
    return url ? [{ ...attachment, url }] : [];
  });
  if (!videos.length) return null;
  return (
    <div className={styles.messageAttachments}>
      {videos.map((attachment) => (
        <MediaAttachment
          key={attachment.url}
          attachment={attachment}
          media={media}
          handoff={{ messageId: row.id, reader: true }}
          {...(onOpenMediaReview
            ? {
                onOpenReview: (item, seconds) =>
                  onOpenMediaReview(
                    row.id,
                    item,
                    seconds,
                    row.replyCount > 0 ||
                      (!!row.threadRootId && row.threadRootId !== row.id),
                    row.attachments,
                  ),
              }
            : {})}
        />
      ))}
    </div>
  );
}
