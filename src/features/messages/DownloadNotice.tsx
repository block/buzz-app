import { useState } from "react";
import { FolderOpenIcon } from "../../shared/design-system/icons";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { useToastNotification } from "../../shared/design-system/ui/Toast";
import { canOpenDownloadsFolder, openDownloadsFolder } from "./native-download";

const label = "Open Downloads";
const openError = "Couldn’t open the Downloads folder.";

function openFolder(onError: (message: string) => void) {
  void openDownloadsFolder().catch(() => onError(openError));
}

/** Called after the native host has saved a file in Downloads. */
export function notifyDownloadSaved(
  notify: ReturnType<typeof useToastNotification>,
  showFolderAction?: () => void,
  title = "Saved to Downloads",
) {
  if (!canOpenDownloadsFolder()) {
    notify(title, "success");
    return;
  }
  showFolderAction?.();
  notify(title, "success", {
    label,
    variant: "link",
    onClick: () => openFolder((message) => notify(message, "error")),
  });
}

/** Modal focus stays inside the viewer. The window toast survives dismissal. */
export function OpenDownloadsButton() {
  const notify = useToastNotification();
  const [error, setError] = useState("");
  return (
    <>
      <IconButton
        size="sm"
        variant="ghost"
        aria-label={label}
        title={label}
        icon={<FolderOpenIcon size={16} aria-hidden="true" />}
        onClick={() => {
          setError("");
          openFolder((message) => {
            setError(message);
            notify(message, "error");
          });
        }}
      />
      {error && (
        <span className="sr-only" role="alert">
          {error}
        </span>
      )}
    </>
  );
}
