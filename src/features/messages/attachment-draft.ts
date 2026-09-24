import { useState, useSyncExternalStore } from "react";
import type { RelaySession } from "../relay/session";
import {
  UPLOAD_MAX_BYTES,
  UploadError,
  type UploadedAttachment,
} from "../relay/attachments";
import { prepareAttachment } from "./prepare-attachment";

export type DraftAttachment = Readonly<{
  id: string;
  file: File;
  status: "queued" | "preparing" | "uploading" | "ready" | "error";
  uploaded?: UploadedAttachment;
  error?: string | undefined;
}>;
type AttachmentDraft = {
  snapshot(): readonly DraftAttachment[];
  subscribe(listener: () => void): () => void;
  add(files: readonly File[]): void;
  remove(id: string): void;
  retry(id: string): void;
  cancel(): void;
  clear(): void;
};
const drafts = new WeakMap<RelaySession, Map<string, AttachmentDraft>>();
const MAX_FILES = 10;
const MAX_RETAINED_BYTES = 2 * UPLOAD_MAX_BYTES;

/** Tab-local files survive navigation, not reload. Delivery remains outbox-owned. */
function attachmentDraft(
  session: RelaySession,
  key: string,
  channelId: string,
): AttachmentDraft {
  let partition = drafts.get(session);
  if (!partition) {
    partition = new Map();
    drafts.set(session, partition);
  }
  const existing = partition.get(key);
  if (existing) return existing;
  const owners = partition;
  let items: readonly DraftAttachment[] = [];
  const listeners = new Set<() => void>();
  const active = new Map<string, AbortController>();
  const emit = () => {
    for (const listener of listeners) listener();
  };
  const replace = (id: string, change: Partial<DraftAttachment>) => {
    items = items.map((item) =>
      item.id === id ? { ...item, ...change } : item,
    );
    emit();
  };
  function cancelActive() {
    for (const controller of active.values()) controller.abort();
    active.clear();
    items = items.map((item) =>
      ["queued", "preparing", "uploading"].includes(item.status)
        ? {
            ...item,
            status: "error",
            error: "Upload paused. Retry to continue.",
          }
        : item,
    );
    emit();
  }
  function pump() {
    const attachments = session.attachments;
    if (!listeners.size || !attachments) return;
    for (const item of items) {
      if (active.size >= 2) break;
      if (item.status !== "queued") continue;
      const controller = new AbortController();
      active.set(item.id, controller);
      replace(item.id, { status: "preparing", error: undefined });
      void (async () => {
        try {
          const prepared = await prepareAttachment(
            item.file,
            controller.signal,
          );
          controller.signal.throwIfAborted();
          replace(item.id, { status: "uploading" });
          const uploaded = await attachments.upload(
            prepared,
            channelId,
            controller.signal,
          );
          controller.signal.throwIfAborted();
          replace(item.id, { status: "ready", uploaded });
        } catch (error) {
          if (!controller.signal.aborted)
            replace(item.id, {
              status: "error",
              error:
                error instanceof Error
                  ? error.message
                  : "Upload failed. Retry or remove this file.",
            });
        } finally {
          if (active.get(item.id) === controller) {
            active.delete(item.id);
            pump();
          }
        }
      })();
    }
  }
  const store = {
    snapshot: () => items,
    subscribe(listener: () => void) {
      owners.set(key, store);
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (!listeners.size) {
          cancelActive();
          if (!items.length && owners.get(key) === store) owners.delete(key);
        }
      };
    },
    add(files: readonly File[]) {
      if (!session.attachments) throw new UploadError("unavailable");
      if (items.length + files.length > MAX_FILES)
        throw new Error(`Attach at most ${MAX_FILES} files per message.`);
      for (const file of files)
        if (!file.size || file.size > UPLOAD_MAX_BYTES)
          throw new UploadError("size");
      const retained = [...owners.values()]
        .flatMap((owner) => owner.snapshot())
        .reduce((sum, item) => sum + item.file.size, 0);
      if (
        retained + files.reduce((sum, file) => sum + file.size, 0) >
        MAX_RETAINED_BYTES
      )
        throw new Error(
          "Attachment drafts are full (1,000 MiB). Send or remove some files first.",
        );
      items = [
        ...items,
        ...files.map(
          (file): DraftAttachment => ({
            id: crypto.randomUUID(),
            file,
            status: "queued",
          }),
        ),
      ];
      owners.set(key, store);
      emit();
      pump();
    },
    remove(id: string) {
      active.get(id)?.abort();
      active.delete(id);
      items = items.filter((item) => item.id !== id);
      emit();
      pump();
    },
    retry(id: string) {
      if (!items.some((item) => item.id === id && item.status === "error"))
        return;
      replace(id, { status: "queued", error: undefined });
      pump();
    },
    cancel: cancelActive,
    clear() {
      cancelActive();
      items = [];
      emit();
    },
  };
  return store;
}

export function useAttachmentDraft(
  session: RelaySession,
  key: string,
  channelId: string,
) {
  // Composer's destination key remounts this hook on a session/channel/thread change.
  const [store] = useState(() => attachmentDraft(session, key, channelId));
  const items = useSyncExternalStore(
    store.subscribe,
    store.snapshot,
    store.snapshot,
  );
  return {
    store,
    items,
    blocked: items.some((item) => item.status !== "ready"),
  };
}
