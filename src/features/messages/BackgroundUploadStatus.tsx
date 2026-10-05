import { Button } from "../../shared/design-system/ui/Button";
import { ToastNotice } from "../../shared/design-system/ui/Toast";
import type { RelaySession } from "../relay/session";
import {
  cancelBackgroundUpload,
  dismissBackgroundUploadNotice,
  useBackgroundUploads,
} from "./background-upload";
import styles from "./Messages.module.css";

/** Desktop's composer upload pill and failure toasts, for this session's sends. */
export function BackgroundUploadStatus({ session }: { session: RelaySession }) {
  const uploads = useBackgroundUploads(session);
  const label =
    uploads.phase === "Uploading"
      ? `${uploads.phase} ${uploads.percentage}%`
      : uploads.phase;
  return (
    <>
      {uploads.uploading && (
        <div className={styles.backgroundUpload}>
          <span role="status">{label}</span>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => cancelBackgroundUpload(session)}
          >
            Cancel
          </Button>
        </div>
      )}
      {uploads.notices.map((notice) => (
        <ToastNotice
          key={notice.id}
          title={notice.message}
          onDismiss={() => dismissBackgroundUploadNotice(session, notice.id)}
        />
      ))}
    </>
  );
}
