import {
  DownloadIcon,
  FileTextIcon,
} from "../../shared/design-system/icons/index";
import type { Attachment } from "../relay/contracts";
import styles from "./Messages.module.css";

export function formatFileSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  if (size < 1024 * 1024 * 1024)
    return `${Math.round(size / (1024 * 1024))} MB`;
  return `${Math.round(size / (1024 * 1024 * 1024))} GB`;
}

function mimeLabel(mime: string | undefined): string | undefined {
  if (!mime) return undefined;
  const [type, subtype] = mime.split("/");
  if (!type || !subtype) return undefined;
  if (subtype === "pdf") return "PDF file";
  if (!/^[a-z0-9]+$/i.test(subtype)) return undefined;
  return `${subtype.toUpperCase()} file`;
}

export function FileAttachment({
  attachment,
  source,
}: {
  attachment: Attachment;
  source: string | undefined;
}) {
  const displayName = attachment.name ?? mimeLabel(attachment.mime) ?? "File";
  const content = (
    <>
      <FileTextIcon size={24} aria-hidden="true" />
      <span className={styles.fileAttachmentBody}>
        <span className={styles.fileAttachmentName}>{displayName}</span>
        <span className={styles.fileAttachmentMeta}>
          {source
            ? attachment.size
              ? formatFileSize(attachment.size)
              : "Download file"
            : "File unavailable"}
        </span>
      </span>
      {source && <DownloadIcon size={20} aria-hidden="true" />}
    </>
  );
  if (!source)
    return (
      <span className={styles.fileAttachment} role="status">
        {content}
      </span>
    );
  return (
    <a
      className={styles.fileAttachment}
      href={source}
      download={attachment.name ?? ""}
      aria-label={`Download ${displayName}`}
    >
      {content}
    </a>
  );
}
