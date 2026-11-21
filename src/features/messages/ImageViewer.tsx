import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { MediaReviewFrame } from "./MediaReviewFrame";
import { ImageReviewStage } from "./ImageReviewStage";
import { safeMessageUrl } from "../relay/message-content";
import type { Attachment } from "../relay/contracts";
import type { RelayData, RelaySnapshot } from "../relay/service";

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
  // A source that fails to load or decode shows the stage's unavailable
  // status, keeping the viewer and its Close; a new source tries again.
  const [failed, setFailed] = useState<string>();
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
        media={() => (failed === source ? undefined : source)}
        onImageError={setFailed}
        onOpenLink={() => false}
      />
    </MediaReviewFrame>
  );
}

const noRelay = () => () => {};
const noSnapshot = () => undefined;

/** Resolves media through `relay` as it changes. The selected community's
 * media needs the session's signed read, so before the session can give one
 * (connecting, disconnected or switching) it resolves to nothing and the
 * viewer closes. Other https images load directly. */
export function RelayImageViewer({
  relay,
  ...props
}: ImageViewerProps & { relay: RelayData | undefined }) {
  const snapshot: RelaySnapshot | undefined = useSyncExternalStore(
    relay?.subscribe ?? noRelay,
    relay?.snapshot ?? noSnapshot,
  );
  const ready = snapshot?.origin;
  const selected = relay?.selected?.();
  const isMedia = (origin: string | undefined, url: string) =>
    origin !== undefined && url.startsWith(`${origin}/media/`);
  return (
    <ImageViewer
      {...props}
      media={(url) => {
        if (isMedia(ready, url) && (!selected || selected === ready))
          return snapshot?.session.media(url);
        if (isMedia(selected, url) || isMedia(ready, url)) return undefined;
        return url;
      }}
    />
  );
}
