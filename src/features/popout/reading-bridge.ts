import type { ReadingHandle, UnreadCapability } from "../relay/unread";

/** Companion reading over a same-origin BroadcastChannel, like the composer
 * bridge: the companion measures geometry, focus and dwell with `useReading`;
 * every lease lives in the main window, which validates ids against this
 * window's projection and publishes intent. Observation promises complete when
 * main's durability completes, so the earned lease is disposed only afterward;
 * a lease disposed by blur, hide or manual unread answers no later request. */
export type ReadingRequest =
  | { kind: "acquire"; lease: string; revision: number }
  | { kind: "view"; lease: string; ids: readonly string[] }
  | { kind: "observe"; id: number; lease: string; ids: readonly string[] }
  | { kind: "catchUp"; id: number; lease: string; messageId: string }
  | { kind: "dispose"; lease: string };
export type ReadingResponse =
  | { kind: "result"; id: number; error?: string }
  | { kind: "closed" };
const MAX_LEASES = 8;
const hex = /^[0-9a-f]{64}$/;
const channelName = (token: string) => `buzz.popout.reading.${token}`;

/** Main-window side: one owner per pop-out window. */
export function createReadingOwner(
  reading: Pick<UnreadCapability, "reading" | "revision">,
  channelId: string,
  /** The thread this window shows, or none for a conversation timeline. */
  rootId: string | undefined,
  /** Ids this window currently presents; nothing else is ever claimed read. */
  known: () => ReadonlySet<string>,
  enabled: () => boolean,
) {
  const token = crypto.randomUUID();
  const channel = new BroadcastChannel(channelName(token));
  const leases = new Map<string, ReadingHandle>();
  let closed = false;
  const post = (response: ReadingResponse) => {
    if (!closed) channel.postMessage(response);
  };
  const ids = (value: unknown) => {
    const present = known();
    return Array.isArray(value)
      ? value
          .filter(
            (id): id is string =>
              typeof id === "string" && hex.test(id) && present.has(id),
          )
          .slice(0, 128)
      : [];
  };
  channel.onmessage = ({ data }: MessageEvent<ReadingRequest>) => {
    if (
      closed ||
      !data ||
      typeof data.lease !== "string" ||
      data.lease.length > 64
    )
      return;
    const handle = leases.get(data.lease);
    switch (data.kind) {
      case "acquire":
        // Event-time fence: intent formed before any newer durable change in
        // main (a manual unread, above all) acquires nothing. The companion
        // re-measures on its next event with the revision it then sees.
        if (handle || !enabled() || data.revision !== reading.revision())
          return;
        if (leases.size >= MAX_LEASES) {
          const oldest = leases.keys().next().value;
          if (oldest) {
            leases.get(oldest)?.dispose();
            leases.delete(oldest);
          }
        }
        try {
          leases.set(data.lease, reading.reading(channelId, rootId));
        } catch {
          /* Membership may disappear between commit and observation. */
        }
        return;
      case "view": {
        const measured = new Set(ids(data.ids));
        try {
          handle?.view([...measured], (id, known) => known && measured.has(id));
        } catch {
          leases.delete(data.lease);
        }
        return;
      }
      case "observe":
      case "catchUp": {
        if (!Number.isSafeInteger(data.id)) return;
        if (!handle) {
          post({ kind: "result", id: data.id, error: "Reading lease ended." });
          return;
        }
        const work =
          data.kind === "observe"
            ? handle.observe(ids(data.ids))
            : typeof data.messageId === "string" && known().has(data.messageId)
              ? handle.catchUp(data.messageId, rootId)
              : Promise.reject(new Error("Unknown message."));
        void work.then(
          () => post({ kind: "result", id: data.id }),
          (cause: unknown) =>
            post({
              kind: "result",
              id: data.id,
              error: (cause instanceof Error
                ? cause.message
                : "Reading could not be recorded."
              ).slice(0, 2048),
            }),
        );
        return;
      }
      case "dispose":
        handle?.dispose();
        leases.delete(data.lease);
        return;
    }
  };
  return {
    token,
    dispose() {
      if (closed) return;
      post({ kind: "closed" });
      closed = true;
      for (const lease of leases.values()) lease.dispose();
      leases.clear();
      channel.close();
    },
  };
}

/** Companion side: a `useReading` session whose leases live in main. */
export function createReadingProxy(
  token: string,
  enabled: () => boolean,
  /** The latest `readingRevision` this window received from main. */
  revision: () => number,
) {
  const channel = new BroadcastChannel(channelName(token));
  let next = 0;
  let closed = false;
  const waiting = new Map<
    number,
    { resolve(): void; reject(error: Error): void }
  >();
  const request = (
    message: Extract<ReadingRequest, { id: number }>,
  ): Promise<void> => {
    if (closed) return Promise.reject(new Error("Reading bridge closed."));
    return new Promise((resolve, reject) => {
      waiting.set(message.id, { resolve, reject });
      channel.postMessage(message);
    });
  };
  const stop = (reason: string) => {
    if (closed) return;
    closed = true;
    for (const pending of waiting.values()) pending.reject(new Error(reason));
    waiting.clear();
    channel.close();
  };
  channel.onmessage = ({ data }: MessageEvent<ReadingResponse>) => {
    if (closed || !data) return;
    if (data.kind === "closed") {
      stop("Reading bridge closed.");
      return;
    }
    const pending = waiting.get(data.id);
    if (!pending) return;
    waiting.delete(data.id);
    if (data.error) pending.reject(new Error(data.error));
    else pending.resolve();
  };
  const unread: Pick<UnreadCapability, "reading" | "sync"> = {
    sync: () => ({
      capability: enabled() && !closed ? "frontier-sync" : "unsupported",
      status: "local",
      completeness: "unknown",
    }),
    reading(_channelId): ReadingHandle {
      const lease = crypto.randomUUID();
      let disposed = false;
      if (!closed)
        channel.postMessage({ kind: "acquire", lease, revision: revision() });
      return {
        view(ids) {
          if (!disposed && !closed)
            channel.postMessage({ kind: "view", lease, ids: [...ids] });
        },
        observe: (ids) =>
          disposed
            ? Promise.reject(new Error("Reading lease ended."))
            : request({ kind: "observe", id: ++next, lease, ids: [...ids] }),
        catchUp: (messageId) =>
          disposed
            ? Promise.reject(new Error("Reading lease ended."))
            : request({ kind: "catchUp", id: ++next, lease, messageId }),
        dispose() {
          if (disposed) return;
          disposed = true;
          if (!closed) channel.postMessage({ kind: "dispose", lease });
        },
      };
    },
  };
  return {
    unread,
    dispose: () => stop("Reading bridge closed."),
  };
}
