import { useEffect, useRef, useState } from "react";
import { Button } from "../../shared/design-system/ui/Button";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { FileTextIcon, XIcon } from "../../shared/design-system/icons";
import type { DraftAttachment } from "./attachment-draft";
import styles from "./ComposerAttachments.module.css";

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
  if (!items.length) return null;
  return (
    <section aria-label="Attachments" className={styles.attachments}>
      <ul className={styles.list}>
        {items.map((item) => (
          <AttachmentItem
            media={media}
            key={item.id}
            item={item}
            disabled={disabled}
            remove={remove}
            retry={retry}
          />
        ))}
      </ul>
      <p className={styles.hint}>
        Files stay in this tab’s draft when you switch conversations. Reloading
        discards unsent files.
      </p>
    </section>
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
  remove(id: string): void;
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
    <li className={styles.item}>
      {source && !failed ? (
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
      ) : (
        <span className={styles.fileIcon}>
          <FileTextIcon size={24} />
        </span>
      )}
      <div className={styles.details}>
        <span className={styles.name} title={item.file.name}>
          {item.file.name}
        </span>
        <span className={styles.hint}>
          {size} · {status}
        </span>
        {failed && <span className={styles.hint}>Preview unavailable</span>}
        {item.error && (
          <span className={styles.error} role="alert">
            {item.error}
          </span>
        )}
        {item.status === "error" && (
          <Button
            size="sm"
            variant="ghost"
            type="button"
            disabled={disabled}
            onClick={() => retry(item.id)}
          >
            Retry
          </Button>
        )}
      </div>
      <IconButton
        size="sm"
        type="button"
        disabled={disabled}
        aria-label={`Remove ${item.file.name}`}
        title="Remove attachment"
        onClick={() => remove(item.id)}
        icon={<XIcon size={16} />}
      />
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
