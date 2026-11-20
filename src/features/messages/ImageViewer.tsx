import { useEffect, useRef } from "react";
import { MediaReviewFrame } from "./MediaReviewFrame";
import { ImageReviewStage } from "./ImageReviewStage";
import { safeMessageUrl } from "../relay/message-content";
import type { Attachment } from "../relay/contracts";

export type ImageViewerProps = Readonly<{
  /** An https image URL, relay-hosted media included. Anything else, or media
   * the session cannot read, shows nothing and calls `onClose`. */
  src: string;
  /** Title in the viewer's header. */
  name?: string | undefined;
  /** Escape, the backdrop and the close button ask the caller to unmount it. */
  onClose(): void;
}>;

/** The fullscreen image viewer for an image that is not a message attachment.
 * `media` is the session's resolver, so relay-hosted media gets its signed read. */
export function ImageViewer({
  src,
  name,
  onClose,
  media,
}: ImageViewerProps & { media(url: string): string | undefined }) {
  const frame = useRef<HTMLElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const url = safeMessageUrl(src);
  const source = url && media(url);
  useEffect(() => {
    if (!source) onClose();
  }, [source, onClose]);
  if (!url || !source) return null;
  const title = name?.trim() || "Image";
  const attachment: Attachment = { url, name: title, kind: "image" };
  return (
    <MediaReviewFrame
      title={title}
      label="Image viewer"
      isVideo={false}
      video={video}
      frame={frame}
      origin={undefined}
      close={onClose}
    >
      <ImageReviewStage
        attachments={[attachment]}
        selectedUrl={url}
        select={() => {}}
        media={() => source}
        onOpenLink={() => false}
      />
    </MediaReviewFrame>
  );
}
