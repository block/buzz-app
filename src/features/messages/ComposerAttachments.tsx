import { useEffect, useRef, useState } from "react";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { Tooltip } from "../../shared/design-system/ui/Tooltip";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import {
  ArrowsClockwiseIcon,
  CircleNotchIcon,
  FileTextIcon,
  WarningCircleIcon,
  XIcon,
} from "../../shared/design-system/icons";
import type { DraftAttachment } from "./attachment-draft";
import styles from "./ComposerAttachments.module.css";
import { useAttachmentPoof } from "./AttachmentPoof";

export function ComposerAttachments({
  items,
  disabled,
  remove,
  retry,
  media,
}: {
  media(url: string): string | undefined;
  items: readonly DraftAttachment[];
  disabled: boolean;
  remove(id: string): void;
  retry(id: string): void;
}) {
  const poof = useAttachmentPoof(items.length > 0);
  return (
    <>
      {poof.overlay}
      {items.length > 0 && (
        <section aria-label="Attachments" className={styles.attachments}>
          <ul className={styles.list}>
            {items.map((item) => (
              <AttachmentItem
                media={media}
                key={item.id}
                item={item}
                disabled={disabled}
                remove={(id, origin) => {
                  remove(id);
                  poof.emit(origin);
                }}
                retry={retry}
              />
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
function AttachmentItem({
  item,
  disabled,
  remove,
  retry,
  media,
}: {
  media(url: string): string | undefined;
  item: DraftAttachment;
  disabled: boolean;
  remove(id: string, origin: DOMRect): void;
  retry(id: string): void;
}) {
  const [source, setSource] = useState<string>();
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const type = item.uploaded?.type || item.file.type || "";
  const uploadedSource = item.uploaded ? media(item.uploaded.url) : undefined;
  // Once uploaded, the relay's canonical type wins over the original name/type.
  const image =
    /^image\/(png|jpeg|gif|webp)$/.test(type) ||
    (!item.uploaded && /\.(png|jpe?g|gif|webp)$/i.test(item.file.name));
  const video =
    type.startsWith("video/") ||
    (!item.uploaded && /\.(mp4|mov|webm|m4v)$/i.test(item.file.name));
  useEffect(() => {
    setFailed(false);
    if (!image && !video) {
      setSource(undefined);
      return;
    }
    if (item.uploaded) {
      setSource(uploadedSource);
      return;
    }
    const url = URL.createObjectURL(item.file);
    setSource(url);
    return () => URL.revokeObjectURL(url);
  }, [item.file, item.uploaded, image, video, uploadedSource]);
  const size =
    item.file.size < 1024 * 1024
      ? `${Math.max(1, Math.round(item.file.size / 1024))} KB`
      : `${(item.file.size / (1024 * 1024)).toFixed(1)} MB`;
  const status = {
    queued: "Queued",
    preparing: "Preparing…",
    uploading: "Uploading…",
    ready: "Ready",
    error: "Upload failed",
  }[item.status];
  return (
    <li
      className={styles.item}
      data-media={source && !failed && item.status !== "error" ? "" : undefined}
    >
      {source && !failed ? (
        <Tooltip content={`${item.file.name} · ${size} · ${status}`}>
          <button
            ref={trigger}
            className={styles.preview}
            type="button"
            aria-label={`Preview ${item.file.name}`}
            onClick={() => setOpen(true)}
          >
            {image ? (
              <img
                key={source}
                src={source}
                alt=""
                onError={() => setFailed(true)}
              />
            ) : (
              <video
                key={source}
                src={source}
                muted
                playsInline
                preload="metadata"
                onError={() => setFailed(true)}
                onLoadedMetadata={(event) => {
                  event.currentTarget.currentTime = Math.min(
                    0.1,
                    event.currentTarget.duration || 0.1,
                  );
                }}
              />
            )}
          </button>
        </Tooltip>
      ) : (
        <span className={styles.fileIcon}>
          <FileTextIcon size={24} />
        </span>
      )}
      <div className={styles.details}>
        <Tooltip content={`${item.file.name} · ${size} · ${type || "File"}`}>
          <span className={styles.name} tabIndex={source && !failed ? -1 : 0}>
            {item.file.name}
          </span>
        </Tooltip>
        <span
          className={styles.hint}
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          <span className="sr-only">{item.file.name}: </span>
          {size} · {status}
        </span>
        {failed && <span className="sr-only">Preview unavailable</span>}
      </div>
      <div className={styles.actions}>
        {(item.error || failed) && (
          <span className={styles.error}>
            <IconButton
              size="xs"
              aria-label={`Attachment issue: ${item.file.name}`}
              title={item.error || "Preview unavailable"}
              icon={<WarningCircleIcon size={16} />}
            />
            {item.error && (
              <span role="alert" className="sr-only">
                {item.error}
              </span>
            )}
          </span>
        )}
        {item.status === "error" && (
          <IconButton
            size="xs"
            variant="ghost"
            disabled={disabled}
            aria-label={`Retry ${item.file.name}`}
            title="Retry upload"
            onClick={() => retry(item.id)}
            icon={<ArrowsClockwiseIcon size={16} />}
          />
        )}
        <IconButton
          size="xs"
          variant="primary"
          type="button"
          disabled={disabled}
          aria-label={`Remove ${item.file.name}`}
          title="Remove attachment"
          onClick={(event) =>
            remove(item.id, event.currentTarget.getBoundingClientRect())
          }
          data-uploading={
            !["ready", "error"].includes(item.status) || undefined
          }
          icon={
            <span className={styles.removeIcon}>
              {!["ready", "error"].includes(item.status) && (
                <CircleNotchIcon className={styles.spinner} size={16} />
              )}
              <XIcon className={styles.removeX} size={16} />
            </span>
          }
        />
      </div>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title={item.file.name}
        finalFocus={trigger}
      >
        {open &&
          source &&
          (image ? (
            <img
              className={styles.fullPreview}
              src={source}
              alt={item.file.name}
            />
          ) : (
            // biome-ignore lint/a11y/useMediaCaption: user-selected video has no caption track.
            <video
              className={styles.fullPreview}
              src={source}
              controls
              playsInline
            />
          ))}
      </Dialog>
    </li>
  );
}
