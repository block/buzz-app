import { useEffect, useState, useSyncExternalStore } from "react";
import type { UploadedAttachment } from "../relay/attachments";
import type { RelaySession } from "../relay/session";
import {
  attachmentDraft,
  clearAttachmentDraft,
  type AttachmentDraft,
  type DraftAttachment,
} from "./attachment-draft";

type Notice = Readonly<{ id: string; message: string }>;
export type BackgroundUploads = Readonly<{
  uploading: boolean;
  phase: "Preparing" | "Uploading" | "Finishing";
  /** Completed-file bytes; uploads report no byte-level progress. */
  percentage: number;
  notices: readonly Notice[];
  host: object | undefined;
}>;
type Job = { store: AttachmentDraft; controller: AbortController };
type Queue = {
  jobs: Job[];
  notices: readonly Notice[];
  hosts: object[];
  listeners: Set<() => void>;
  snapshot: BackgroundUploads;
  subscribe(listener: () => void): () => void;
};

// Sends outlive their composer but not their session: in memory, as Desktop.
const queues = new WeakMap<RelaySession, Queue>();

function queueFor(session: RelaySession) {
  let queue = queues.get(session);
  if (!queue) {
    const listeners = new Set<() => void>();
    queue = {
      jobs: [],
      notices: [],
      hosts: [],
      listeners,
      snapshot: {
        uploading: false,
        phase: "Preparing",
        percentage: 0,
        notices: [],
        host: undefined,
      },
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    queues.set(session, queue);
  }
  return queue;
}

function update(queue: Queue) {
  const files = queue.jobs.flatMap((job) => job.store.snapshot());
  const total = files.reduce((sum, item) => sum + item.file.size, 0);
  const done = files
    .filter((item) => item.status === "ready")
    .reduce((sum, item) => sum + item.file.size, 0);
  queue.snapshot = Object.freeze({
    uploading: queue.jobs.length > 0,
    phase: files.some((item) => item.status === "uploading")
      ? "Uploading"
      : files.every((item) => item.status === "ready")
        ? "Finishing"
        : "Preparing",
    percentage: total ? Math.round((done / total) * 100) : 0,
    notices: queue.notices,
    host: queue.hosts[0],
  });
  for (const listener of queue.listeners) listener();
}

function reason(error: unknown) {
  return error instanceof Error && error.message
    ? error.message
    : "Unknown error";
}

/** Takes admitted files after Send; files upload in order, then publish once.
 * Cancel and failure hand the files back to `recover`; a closed session drops them. */
export function sendInBackground(
  session: RelaySession,
  channelId: string,
  files: readonly DraftAttachment[],
  publish: (uploaded: readonly UploadedAttachment[]) => void,
  recover: (files: readonly DraftAttachment[]) => void,
) {
  const queue = queueFor(session);
  const key = `background:${crypto.randomUUID()}`;
  const store = attachmentDraft(session, key, channelId);
  store.adopt(files);
  const job = { store, controller: new AbortController() };
  const { signal } = job.controller;
  queue.jobs.push(job);
  const stop = store.subscribe(() => update(queue));
  update(queue);
  void (async () => {
    let uploaded: readonly UploadedAttachment[] | undefined;
    let notice: string | undefined;
    try {
      uploaded = await store.prepareForSend(signal);
      signal.throwIfAborted();
      publish(uploaded);
      return;
    } catch (error) {
      // Sign-out, leave and reconnection abort session uploads without a user action.
      if (
        !signal.aborted &&
        error instanceof Error &&
        error.name === "AbortError"
      )
        return;
      if (!signal.aborted)
        notice = uploaded
          ? `Message failed to send: ${reason(error)}`
          : `Upload failed: ${reason(error)}`;
    } finally {
      if (notice !== undefined || signal.aborted) recover(store.snapshot());
      if (notice !== undefined)
        queue.notices = [...queue.notices, { id: key, message: notice }];
      queue.jobs = queue.jobs.filter((candidate) => candidate !== job);
      clearAttachmentDraft(session, key);
      stop();
      update(queue);
    }
  })();
}

/** Desktop's Cancel stops the newest send and restores it like a failure. */
export function cancelBackgroundUpload(session: RelaySession) {
  const live = queueFor(session).jobs.filter(
    (job) => !job.controller.signal.aborted,
  );
  live.at(-1)?.controller.abort();
}

export function dismissBackgroundUploadNotice(
  session: RelaySession,
  id: string,
) {
  const queue = queueFor(session);
  queue.notices = queue.notices.filter((notice) => notice.id !== id);
  update(queue);
}

/** Every composer shows progress; only the first mounted one hosts notices. */
export function useBackgroundUploads(session: RelaySession) {
  const queue = queueFor(session);
  const [host] = useState(() => ({}));
  useEffect(() => {
    queue.hosts.push(host);
    update(queue);
    return () => {
      queue.hosts = queue.hosts.filter((candidate) => candidate !== host);
      update(queue);
    };
  }, [queue, host]);
  const snapshot = useSyncExternalStore(
    queue.subscribe,
    () => queue.snapshot,
    () => queue.snapshot,
  );
  return {
    ...snapshot,
    notices: snapshot.host === host ? snapshot.notices : [],
  };
}
