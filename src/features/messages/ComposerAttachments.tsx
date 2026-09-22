import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "../../shared/design-system/ui/Button";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { FileTextIcon, XIcon } from "../../shared/design-system/icons/index";

import { createAttachmentQueue } from "./attachment-queue";
import {
  UPLOAD_FAILURES,
  UploadError,
  type AttachmentUpload,
} from "../relay/attachments";
const PREVIEW_LIMIT = 10 * 1024 * 1024;

export function useLocalAttachments(upload?: AttachmentUpload) {
  const [files, setFiles] = useState<
    ReturnType<ReturnType<typeof createAttachmentQueue>["snapshot"]>
  >([]);
  const [error, setError] = useState<string>();
  const input = useRef<HTMLInputElement>(null);
  const queue = useRef<ReturnType<typeof createAttachmentQueue> | null>(null);
  const currentUpload = useRef(upload);
  currentUpload.current = upload;
  useEffect(() => {
    const owned = createAttachmentQueue((file, signal) => {
      if (!currentUpload.current) throw new UploadError("unavailable");
      return currentUpload.current(file, signal);
    });
    queue.current = owned;
    const stop = owned.subscribe(() => setFiles(owned.snapshot()));
    setFiles(owned.snapshot());
    return () => {
      stop();
      owned.dispose();
      if (queue.current === owned) queue.current = null;
    };
  }, []);
  return {
    files,
    available: !!upload,
    error,
    input,
    blocked: files.some((file) => file.state !== "ready"),
    content: (text: string) => queue.current?.content(text) ?? text,
    add(selected: FileList | null) {
      if (currentUpload.current && selected?.length)
        setError(queue.current?.add(Array.from(selected)));
    },
    remove(id: number) {
      queue.current?.remove(id);
      setError(undefined);
    },
    retry(id: number) {
      if (currentUpload.current) queue.current?.retry(id);
    },
    clear() {
      queue.current?.clear();
      setError(undefined);
    },
  };
}

function ImagePreview({
  file,
  onUnavailable,
}: {
  file: File;
  onUnavailable(): void;
}) {
  const [url, setUrl] = useState<string>();

  useEffect(() => {
    // No file reads/base64 conversion, SVG, documents, video decode or network.
    if (
      file.size > PREVIEW_LIMIT ||
      !/^image\/(png|jpeg|gif|webp)$/.test(file.type)
    ) {
      onUnavailable();
      return;
    }
    const objectUrl = URL.createObjectURL(file);
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [file, onUnavailable]);
  return url ? (
    <img
      className="composer-attachment-thumbnail"
      src={url}
      alt={`Preview of ${file.name}`}
      onError={onUnavailable}
    />
  ) : null;
}

function AttachmentItem({
  item,
  selection,
  disabled,
}: {
  item: ReturnType<typeof useLocalAttachments>["files"][number];
  selection: ReturnType<typeof useLocalAttachments>;
  disabled: boolean;
}) {
  const { id, file, state, error } = item;
  const [previewUnavailable, setPreviewUnavailable] = useState(false);
  const onUnavailable = useCallback(() => setPreviewUnavailable(true), []);
  const image =
    !previewUnavailable &&
    file.size <= PREVIEW_LIMIT &&
    /^image\/(png|jpeg|gif|webp)$/.test(file.type);
  const status =
    state === "failed"
      ? UPLOAD_FAILURES[error ?? "failed"]
      : state === "ready"
        ? "Ready to send"
        : state === "queued"
          ? "Waiting to upload…"
          : "Uploading…";
  return (
    <li className="composer-attachment-item" data-state={state}>
      <div
        className="composer-attachment"
        data-image={image || undefined}
        title={file.name}
      >
        {image ? (
          <ImagePreview file={file} onUnavailable={onUnavailable} />
        ) : (
          <>
            <FileTextIcon size={16} aria-hidden="true" />
            <span className="composer-attachment-name text-body">
              {file.name}
            </span>
          </>
        )}
        <IconButton
          aria-label={`Remove ${file.name}`}
          disabled={disabled}
          size="compact"
          icon={<XIcon size={16} />}
          onClick={() => selection.remove(id)}
        />
      </div>
      <span
        role={state === "failed" ? "alert" : "status"}
        className={
          state === "ready" ? "sr-only" : "text-body-sm text-secondary"
        }
      >
        {status}
      </span>
      {state === "failed" && (
        <div>
          <Button
            size="compact"
            disabled={disabled || !selection.available}
            onClick={() => selection.retry(id)}
          >
            Retry {file.name}
          </Button>
        </div>
      )}
    </li>
  );
}

export function ComposerAttachments({
  selection,
  disabled,
}: {
  selection: ReturnType<typeof useLocalAttachments>;
  disabled: boolean;
}) {
  return (
    <>
      <input
        ref={selection.input}
        type="file"
        multiple
        hidden
        aria-label="Choose attachments"
        disabled={disabled || !selection.available}
        onChange={(event) => {
          if (!disabled) selection.add(event.currentTarget.files);
          event.currentTarget.value = "";
        }}
      />
      {selection.error && (
        <p role="alert" className="text-body-sm text-secondary">
          {selection.error}
        </p>
      )}
      {!!selection.files.length && (
        <section
          aria-label="Selected attachments"
          className="composer-attachments"
        >
          <ul className="composer-attachment-list">
            {selection.files.map((item) => (
              <AttachmentItem
                key={item.id}
                item={item}
                selection={selection}
                disabled={disabled}
              />
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
