import {
  attachmentMarkdown,
  UPLOAD_MAX_BYTES,
  UPLOAD_MAX_FILES,
  UPLOAD_TOTAL_BYTES,
  UPLOAD_TIMEOUT_MS,
  uploadCode,
  type UploadedAttachment,
  type UploadCode,
} from "../relay/attachments";
export type AttachmentItem = Readonly<{
  id: number;
  file: File;
  state: "queued" | "uploading" | "ready" | "failed";
  result?: UploadedAttachment;
  error?: UploadCode;
}>;
export function createAttachmentQueue(
  upload: (file: File, signal: AbortSignal) => Promise<UploadedAttachment>,
) {
  let items: readonly AttachmentItem[] = [];
  let sequence = 0;
  let active = 0;
  let disposed = false;
  const controllers = new Map<number, AbortController>();
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of listeners) listener();
  };
  const patch = (id: number, value: Partial<AttachmentItem>) => {
    if (disposed || !items.some((item) => item.id === id)) return;
    items = items.map((item) =>
      item.id === id ? { ...item, ...value } : item,
    );
    notify();
  };
  function pump() {
    if (disposed) return;
    while (active < 2) {
      const item = items.find((item) => item.state === "queued");
      if (!item) break;
      const controller = new AbortController();
      controllers.set(item.id, controller);
      active++;
      patch(item.id, { state: "uploading" });
      const signal = AbortSignal.any([
        controller.signal,
        AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
      ]);
      let abort: () => void = () => {};
      const cancelled = new Promise<never>((_, reject) => {
        abort = () =>
          reject(new DOMException("Upload cancelled", "AbortError"));
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      });
      void Promise.race([
        Promise.resolve().then(() => {
          signal.throwIfAborted();
          return upload(item.file, signal);
        }),
        cancelled,
      ])
        .then(
          (result) => {
            if (!signal.aborted) patch(item.id, { state: "ready", result });
          },
          (error) =>
            patch(item.id, { state: "failed", error: uploadCode(error) }),
        )
        .finally(() => {
          signal.removeEventListener("abort", abort);
          controllers.delete(item.id);
          active--;
          pump();
        });
    }
  }
  return {
    snapshot: () => items,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    add(files: readonly File[]) {
      if (disposed) return "This composer is closed.";
      if (items.length + files.length > UPLOAD_MAX_FILES)
        return "Choose up to 10 files.";
      if (files.some((file) => !file.size || file.size > UPLOAD_MAX_BYTES))
        return "Choose files between 1 byte and 20 MB.";
      if (
        [...items.map((item) => item.file), ...files].reduce(
          (sum, file) => sum + file.size,
          0,
        ) > UPLOAD_TOTAL_BYTES
      )
        return "Choose up to 40 MB of files per message.";
      items = [
        ...items,
        ...files.map((file) => ({
          id: ++sequence,
          file,
          state: "queued" as const,
        })),
      ];
      notify();
      pump();
      return undefined;
    },
    remove(id: number) {
      items = items.filter((item) => item.id !== id);
      controllers.get(id)?.abort();
      notify();
    },
    retry(id: number) {
      if (
        items.find((item) => item.id === id)?.state !== "failed" ||
        controllers.has(id)
      )
        return;
      patch(id, { state: "queued" });
      pump();
    },
    clear() {
      items = [];
      for (const controller of controllers.values()) controller.abort();
      notify();
    },
    dispose() {
      disposed = true;
      items = [];
      for (const controller of controllers.values()) controller.abort();
      listeners.clear();
    },
    content(text: string) {
      if (items.some((item) => item.state !== "ready"))
        throw new Error(
          "Wait for uploads to finish, or retry or remove failed files.",
        );
      return [
        text,
        ...items.map((item) => {
          if (!item.result) throw new Error("Attachment upload is incomplete.");
          return attachmentMarkdown(item.file.name, item.result);
        }),
      ]
        .filter(Boolean)
        .join("\n\n");
    },
  };
}
