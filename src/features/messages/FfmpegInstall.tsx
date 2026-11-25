import { isHeic } from "../relay/video-preparation";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { useLayoutEffect, useRef, useState } from "react";
import { Button } from "../../shared/design-system/ui/Button";
import styles from "./ComposerAttachments.module.css";

export function FfmpegInstall({
  file,
  disabled,
  retry,
  focusAttachment,
}: {
  file: File;
  disabled: boolean;
  retry(): void;
  focusAttachment?(button: HTMLButtonElement): void;
}) {
  const button = useRef<HTMLButtonElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const selection = useRef<{ file: File } | null>(null);
  useLayoutEffect(() => {
    selection.current = { file };
    setBusy(false);
    setError("");
    return () => {
      selection.current = null;
    };
  }, [file]);
  const desktop =
    isTauri() &&
    !/^Linux/i.test(navigator.platform) &&
    window.location.pathname !== "/huddle.html";
  const needsUpdate =
    /\.(heic|heif)$/i.test(file.name) || /^image\/hei[cf]/.test(file.type);
  async function install() {
    const current = selection.current;
    if (!current) return;
    setBusy(true);
    try {
      if (desktop) {
        const header = new Uint8Array(
          await current.file.slice(0, 4096).arrayBuffer(),
        );
        if (selection.current !== current) return;
        await invoke("install_ffmpeg", {
          requireVersion8: isHeic(header, file.name),
        });
      }
      if (selection.current !== current) return;
      setError("");
      if (button.current && document.activeElement === button.current)
        focusAttachment?.(button.current);
      retry();
    } catch (cause) {
      if (selection.current !== current) return;
      setError(
        typeof cause === "string" ? cause : "Installation failed. Try again.",
      );
    } finally {
      if (selection.current === current) setBusy(false);
    }
  }
  const label = error
    ? "Try again"
    : !desktop
      ? "Retry upload"
      : needsUpdate
        ? "Install or update"
        : "Install";
  return (
    <div className={styles.encoderCard}>
      <div>
        <strong>
          {needsUpdate ? "Install or update FFmpeg" : "Install FFmpeg"}
        </strong>
        <p role="alert">
          <span className="sr-only">Upload failed for {file.name}. </span>
          {error ||
            (desktop
              ? needsUpdate
                ? "Buzz needs FFmpeg 8 or newer to upload this photo."
                : "Buzz uses FFmpeg to send voice notes, videos, and photos."
              : needsUpdate
                ? "Install FFmpeg 8 or newer on the computer running Buzz, then retry or upload a JPEG."
                : "Install FFmpeg on the computer running Buzz, then retry the upload.")}
        </p>
      </div>
      <Button
        ref={button}
        aria-label={`${label} for ${file.name}`}
        variant="prominent"
        size="sm"
        disabled={disabled}
        loading={busy}
        onClick={() => void install()}
      >
        {label}
      </Button>
    </div>
  );
}
