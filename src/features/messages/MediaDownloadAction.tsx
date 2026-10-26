import { useEffect } from "react";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import {
  ArrowsClockwiseIcon,
  CheckIcon,
  DownloadIcon,
} from "../../shared/design-system/icons";
import { useNativeDownload } from "./use-native-download";
import { isNativeMediaSource } from "./attachment-source";

export function MediaDownloadAction({
  source,
  name = "",
  kind,
  compact = false,
  savedDuration = 4000,
  onFeedbackVisible,
}: {
  source: string;
  name?: string | undefined;
  kind: string;
  compact?: boolean;
  savedDuration?: number;
  onFeedbackVisible?: ((visible: boolean) => void) | undefined;
}) {
  if (!isNativeMediaSource(source)) return null;
  return (
    <NativeMediaDownload
      key={JSON.stringify([source, name, kind])}
      source={source}
      name={name}
      kind={kind}
      compact={compact}
      savedDuration={savedDuration}
      onFeedbackVisible={onFeedbackVisible}
    />
  );
}

function NativeMediaDownload({
  source,
  name,
  kind,
  compact,
  savedDuration,
  onFeedbackVisible,
}: {
  source: string;
  name: string;
  kind: string;
  compact: boolean;
  savedDuration: number;
  onFeedbackVisible?: ((visible: boolean) => void) | undefined;
}) {
  const { state, download } = useNativeDownload(source, name, savedDuration);
  useEffect(() => {
    onFeedbackVisible?.(state !== "idle");
    return () => onFeedbackVisible?.(false);
  }, [state, onFeedbackVisible]);
  return (
    <>
      <IconButton
        size="sm"
        type="button"
        aria-label={
          state === "failed" ? `Retry download ${kind}` : `Download ${kind}`
        }
        title={
          state === "failed" ? `Retry download ${kind}` : `Download ${kind}`
        }
        loading={state === "pending"}
        onClick={() => void download()}
        icon={
          state === "failed" ? (
            <ArrowsClockwiseIcon size={17} aria-hidden="true" />
          ) : state === "saved" ? (
            <CheckIcon size={17} aria-hidden="true" />
          ) : (
            <DownloadIcon size={17} aria-hidden="true" />
          )
        }
      />
      <span
        data-download-feedback={state === "idle" ? undefined : ""}
        role={
          state === "idle" ? undefined : state === "failed" ? "alert" : "status"
        }
        className={state === "idle" ? "sr-only" : undefined}
      >
        {state === "pending"
          ? "Downloading…"
          : state === "saved"
            ? compact
              ? "Downloaded"
              : "Saved to Downloads"
            : state === "failed"
              ? compact
                ? "Download failed"
                : "Couldn’t download. Try again."
              : ""}
      </span>
    </>
  );
}
