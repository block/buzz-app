import { useSyncExternalStore } from "react";
import type { ConversationExtensions } from "../conversation/contracts";
import { useMessageRenderer } from "../conversation/MessageBody";
import type { ChannelMessage } from "../relay/contracts";
import { attachmentGroups, playerVideos } from "./attachment-groups";
import { MediaAttachment } from "./MediaAttachment";
import styles from "./Messages.module.css";

type Attachment = ChannelMessage["attachments"][number];
const none: readonly never[] = [];
const noSubscribe = () => () => {};

/** The videos a message's row draws as players, for a reader that opens from
 * the message's id and has no row to ask. A renderer's card that failed is
 * known only to its row, which then draws the videos the card claimed; a
 * reader over such a row leaves those out. */
export function useRowVideos(
  row: ChannelMessage,
  extensions: ConversationExtensions | undefined,
  gallery: boolean,
) {
  const renderer = useMessageRenderer(extensions?.messages, row);
  const attachmentRenderers = useSyncExternalStore(
    extensions?.attachments?.subscribe ?? noSubscribe,
    extensions?.attachments?.snapshot ?? (() => none),
    extensions?.attachments?.snapshot ?? (() => none),
  );
  const { groups } = attachmentGroups(row, {
    claimed: (attachment) => {
      try {
        return !!renderer?.ownsAttachment?.(row, attachment);
      } catch {
        return false;
      }
    },
    drawn: (attachment) =>
      attachment.kind === "image" &&
      attachmentRenderers.some((entry) => {
        try {
          return entry.matches(attachment);
        } catch {
          return false;
        }
      }),
    gallery,
  });
  return playerVideos(groups);
}

/** A details message's videos in its reader: the players its brief shows in
 * the chat, so playback follows the message as it opens and closes. */
export function DetailsVideos({
  row,
  videos,
  media,
  onOpenMediaReview,
}: {
  row: ChannelMessage;
  /** The videos the row draws as players, named by their safe URLs. */
  videos: readonly Attachment[];
  media(url: string): string | undefined;
  onOpenMediaReview?:
    | ((
        messageId: string,
        attachment: Attachment,
        seconds: number,
        hasComments?: boolean,
        attachments?: ChannelMessage["attachments"],
      ) => void)
    | undefined;
}) {
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
