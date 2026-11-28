import { useEffect, useRef, useState } from "react";
import { writeClipboardText } from "../../shared/clipboard";
import { CopyIcon } from "../../shared/design-system/icons";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { useToastNotification } from "../../shared/design-system/ui/Toast";

/** Text to copy. `missing` says what it leaves out, and `unreadable` is the
 * message to show when nothing could be read at all. */
export type CopiedText =
  | string
  | Readonly<{ text: string; missing?: string; unreadable?: string }>;

/** Copies the text `read` gives, read only when pressed: a PDF's text is read
 * from its pages then. Idle, then busy until the copy settles; leaving the
 * file stops a read in progress, and nothing is reported for it. */
export function CopyText({
  read,
  limit,
}: {
  read(signal: AbortSignal): CopiedText | Promise<CopiedText>;
  /** The most characters `read` gives; text that long says it was cut. */
  limit?: number;
}) {
  const notify = useToastNotification();
  const [busy, setBusy] = useState(false);
  const running = useRef<AbortController | null>(null);
  useEffect(() => () => running.current?.abort(), []);
  return (
    <IconButton
      aria-label="Copy text"
      icon={<CopyIcon />}
      disabled={busy}
      onClick={() => {
        const controller = new AbortController();
        running.current = controller;
        setBusy(true);
        const live = () => !controller.signal.aborted;
        Promise.resolve()
          .then(() => read(controller.signal))
          .then((read) => {
            if (!live()) return;
            const { text, missing, unreadable } =
              typeof read === "string" ? { text: read } : read;
            if (!/\S/.test(text))
              return unreadable
                ? notify(unreadable, "error")
                : notify("No text to copy", "info");
            const copied =
              limit !== undefined && text.length >= limit
                ? `Copied the first ${limit.toLocaleString()} characters to clipboard`
                : "Copied text to clipboard";
            return writeClipboardText(text).then(
              () =>
                missing
                  ? notify(`${copied}. ${missing}`, "info")
                  : notify(copied, "success"),
              () => notify("Failed to copy text", "error"),
            );
          })
          .catch(() => {
            if (live()) notify("Failed to copy text", "error");
          })
          .finally(() => {
            if (live()) setBusy(false);
          });
      }}
    />
  );
}
