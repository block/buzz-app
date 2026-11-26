import {
  type Ref,
  type SyntheticEvent,
  useLayoutEffect,
  useSyncExternalStore,
} from "react";
import { AttachmentView } from "../conversation/AttachmentView";
import { useConversationPresentation } from "../conversation/ConversationPresentation";
import type { ConversationExtensions } from "../conversation/contracts";
import type { ChannelMessage } from "../relay/contracts";
import { safeMessageUrl } from "../relay/message-content";
import type { RelaySession } from "../relay/session";
import { AttachmentDownloadContext } from "./AttachmentDownloadContext";
import { attachmentGroups } from "./attachment-groups";
import { AttachmentImage } from "./AttachmentImage";
import { isNativeMediaSource, isProxySource } from "./attachment-source";
import { AudioAttachment } from "./AudioAttachment";
import { FileAttachment } from "./FileAttachment";
import { MediaAttachment, type MediaPlayback } from "./MediaAttachment";
import styles from "./Messages.module.css";
import { briefOf, quietBriefs } from "./playback-handoff";

type Attachment = ChannelMessage["attachments"][number];
const none: readonly never[] = [];
const noSubscribe = () => () => {};

/** A message's attachments as its row lists them: grouped, without those a
 * message renderer claims, and which of them a plugin draws itself. */
export function useAttachmentGroups(
  row: ChannelMessage,
  extensions: ConversationExtensions | undefined,
  {
    claimed,
    gallery,
  }: {
    /** A message renderer draws it in its card. */
    claimed(attachment: Attachment): boolean;
    /** Whether the host opens a gallery. */
    gallery: boolean;
  },
) {
  // A plugin may draw an image itself, such as a shared agent's card; it
  // stands alone rather than joining the gallery around it.
  const attachmentRenderers = useSyncExternalStore(
    extensions?.attachments?.subscribe ?? noSubscribe,
    extensions?.attachments?.snapshot ?? (() => none),
    extensions?.attachments?.snapshot ?? (() => none),
  );
  const drawn = (attachment: Attachment) =>
    attachment.kind === "image" &&
    attachmentRenderers.some((renderer) => {
      try {
        return renderer.matches(attachment);
      } catch {
        return false;
      }
    });
  // Gallery-backed images and videos share a group, preserving sender order.
  return { ...attachmentGroups(row, { claimed, drawn, gallery }), drawn };
}

/** Every attachment of a message, grouped as a row groups them, for a reader
 * that opens from the message's id and has no row to ask. A message
 * renderer's claims don't count here: the reader draws the message's text and
 * never the renderer's card, so an attachment the card would draw is listed. */
export function useReaderAttachments(
  row: ChannelMessage,
  extensions: ConversationExtensions | undefined,
  gallery: boolean,
) {
  return useAttachmentGroups(row, extensions, {
    claimed: () => false,
    gallery,
  });
}

/** A message's attachments, as its row lists them under its text and as a
 * details message's reader lists them under the whole message: one list, so
 * the two cannot differ. */
export function MessageAttachments({
  row,
  groups,
  drawn,
  reader = false,
  session,
  extensions,
  media: attachmentMedia,
  onOpenLink,
  canOpenLink,
  cached = false,
  keepMounted,
  mode,
  seekTo,
  seekRequest,
  onPlayback,
  onOpenMediaReview,
  onLent,
  list,
  onMedia,
}: {
  row: ChannelMessage;
  /** The groups to list, from `useAttachmentGroups`. */
  groups: readonly (readonly Attachment[])[];
  /** A plugin draws it itself. */
  drawn(attachment: Attachment): boolean;
  /** Listed in the reader of a details message rather than in its row. */
  reader?: boolean;
  session?: RelaySession | undefined;
  extensions?: ConversationExtensions | undefined;
  media(url: string, size?: "small"): string | undefined;
  onOpenLink(url: string): boolean;
  canOpenLink?: ((target: string) => boolean) | undefined;
  /** The channel is saved for offline reading. */
  cached?: boolean;
  /** Pins the owning row in a virtualized list; returns the release. */
  keepMounted?: (() => () => void) | undefined;
  mode?: "inline" | "thread" | undefined;
  seekTo?: number | undefined;
  seekRequest?: number | undefined;
  onPlayback?: ((playback: MediaPlayback) => void) | undefined;
  onOpenMediaReview?:
    | ((
        messageId: string,
        attachment: Attachment,
        seconds: number,
        hasComments?: boolean,
        attachments?: ChannelMessage["attachments"],
      ) => void)
    | undefined;
  /** Whether a reader holds playback it took from this row. */
  onLent?: ((lent: boolean) => void) | undefined;
  /** The row's own list, which its action bar and its media tracking find. */
  list?: Ref<HTMLDivElement> | undefined;
  /** Media events from the list's players, plugin ones included. */
  onMedia?: ((event: SyntheticEvent<HTMLDivElement>) => void) | undefined;
}) {
  // A details message's reader takes the playback of its videos and audio
  // clips over from its row, and hands it back. A gallery's tiles never play,
  // so they hand nothing.
  const handoff = reader
    ? { messageId: row.id, reader: true }
    : row.audience === "details"
      ? { messageId: row.id }
      : undefined;
  // What its players do not take over, a plugin's player in the row, stops:
  // nothing in the row plays on under a reader on screen.
  const active = useConversationPresentation();
  useLayoutEffect(() => {
    if (reader && active) quietBriefs(row.id);
  }, [reader, active, row.id]);
  if (!groups.length) return null;
  return (
    <div
      className={styles.messageAttachments}
      data-message-attachments={reader ? undefined : true}
      {...(handoff && !reader ? { [briefOf]: row.id } : {})}
      ref={list}
      onPlay={onMedia}
      onPause={onMedia}
      onEnded={onMedia}
      onEmptied={onMedia}
      onError={onMedia}
    >
      {groups.map((group) => {
        const images = group[0]?.kind === "image" || group[0]?.kind === "video";
        const imageOnly = group.every((item) => item.kind === "image");
        const mediaLabel = imageOnly ? "images" : "photos and videos";
        const files = group[0]?.kind === "file";
        // Only collapse when the host can open the complete gallery.
        const collapsed = images && group.length > 4 && !!onOpenMediaReview;
        const previews = collapsed ? group.slice(0, 4) : group;
        const items = previews.map((attachment, index) => {
          const url = safeMessageUrl(attachment.url);
          if (!url) return null;
          const source = attachmentMedia(url);
          if (attachment.kind === "file") {
            const fallback = (
              <FileAttachment
                key={url}
                attachment={{ ...attachment, url }}
                source={source}
                onOpenLink={onOpenLink}
              />
            );
            return source && extensions?.attachments ? (
              <AttachmentView
                key={url}
                registry={extensions.attachments}
                attachment={{ ...attachment, url }}
                source={source}
                placement="message"
                message={row}
                FileCard={FileAttachment}
                fallback={fallback}
              />
            ) : (
              fallback
            );
          }
          if (attachment.kind === "audio") {
            if (
              source &&
              (isProxySource(source) || isNativeMediaSource(source))
            )
              return extensions?.attachments ? (
                <AttachmentDownloadContext key={url} value={true}>
                  <AttachmentView
                    registry={extensions.attachments}
                    attachment={{ ...attachment, url }}
                    source={source}
                    placement="message"
                    message={row}
                    fallback={
                      <AudioAttachment
                        attachment={{ ...attachment, url }}
                        source={source}
                        {...(handoff ? { handoff, onLent } : {})}
                      />
                    }
                  />
                </AttachmentDownloadContext>
              ) : (
                <AudioAttachment
                  key={url}
                  attachment={{ ...attachment, url }}
                  source={source}
                  {...(handoff ? { handoff, onLent } : {})}
                />
              );
            return (
              <FileAttachment
                key={url}
                attachment={{ ...attachment, url }}
                source={source}
                onOpenLink={onOpenLink}
              />
            );
          }
          if (attachment.kind === "image") {
            const small = attachmentMedia(url, "small");
            // Third-party URLs map to themselves: no thumbnail. JPEG
            // drops alpha, so these formats use the WebP variant.
            const alpha = /^(.+\/[0-9a-f]{64})\.(?:png|gif|webp|avif)$/.exec(
              url,
            );
            const thumbnail =
              small === source
                ? undefined
                : alpha
                  ? attachmentMedia(`${alpha[1]}.thumb.webp`)
                  : small;
            const image = (
              <AttachmentImage
                onOpenLink={
                  canOpenLink?.(attachment.url) ? onOpenLink : undefined
                }
                key={url}
                session={session}
                attachment={{ ...attachment, url }}
                source={source}
                thumbnail={thumbnail}
                cached={cached}
                compact={group.length >= 4}
                overlayCount={collapsed && index === 3 ? group.length - 3 : 0}
                keepMounted={keepMounted}
                label={
                  collapsed && index === 3
                    ? `View all ${group.length} ${mediaLabel}, starting at ${imageOnly ? "image" : "item"} 4`
                    : group.length > 1
                      ? `Open image ${index + 1} of ${group.length}`
                      : "Open image attachment"
                }
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
            );
            return source && extensions?.attachments && drawn(attachment) ? (
              <AttachmentView
                key={url}
                registry={extensions.attachments}
                attachment={{ ...attachment, url }}
                source={source}
                placement="message"
                message={row}
                fallback={image}
              />
            ) : (
              image
            );
          }
          return (
            <MediaAttachment
              key={url}
              attachment={{ ...attachment, url }}
              media={attachmentMedia}
              compact={images && group.length >= 4 && !!onOpenMediaReview}
              overlayCount={collapsed && index === 3 ? group.length - 3 : 0}
              label={
                collapsed && index === 3
                  ? `View all ${group.length} ${mediaLabel}, starting at item 4`
                  : `Open video ${index + 1} of ${group.length}`
              }
              {...(mode ? { mode } : {})}
              {...(handoff ? { handoff, onLent } : {})}
              {...(attachment.kind === "video" && seekTo !== undefined
                ? {
                    seekTo,
                    ...(seekRequest !== undefined ? { seekRequest } : {}),
                  }
                : {})}
              {...(onPlayback ? { onPlayback } : {})}
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
          );
        });
        return images &&
          !(group[0] && drawn(group[0])) &&
          (imageOnly || group.length >= 4) ? (
          <div className={styles.imageGroup} key={group[0]?.url}>
            {/* biome-ignore lint/a11y/useSemanticElements: This labels related media links, not a fieldset of form controls. */}
            <div
              className={`${styles.imageList} ${group.length >= 4 ? styles.imageGrid : ""}`}
              data-image-grid={group.length >= 4 || undefined}
              role="group"
              aria-label={`${group.length} ${imageOnly ? (group.length === 1 ? "image" : "images") : "photos and videos"}`}
            >
              {items}
            </div>
          </div>
        ) : files ? (
          <div className={styles.fileGroup} key={group[0]?.url}>
            {/* A block each, so a copied selection puts every
                card on its own line. */}
            {items.map((item) => item && <div key={item.key}>{item}</div>)}
          </div>
        ) : (
          items
        );
      })}
    </div>
  );
}
