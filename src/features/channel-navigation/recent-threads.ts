import type { ChannelMessage } from "../relay/contracts";
import { messagePreview } from "../relay/membership";
import { isTransientFailure } from "../relay/errors";

export const threadNavigationTags = {
  visit: "buzz-thread-visit-v1",
  pin: "buzz-thread-pin-v1",
} as const;
export type ThreadRecord = Readonly<{
  version: 1;
  channelId: string;
  rootId: string;
  title: string;
  at: number;
}> &
  Readonly<{ type: "visit" } | { type: "pin"; pinned: boolean }>;
export type RecentThread = Readonly<{
  channelId: string;
  rootId: string;
  title: string;
  visitedAt: number;
  pinned?: number;
}>;
export type ThreadNavigationHost = Readonly<{
  read(signal: AbortSignal): Promise<readonly ThreadRecord[]>;
  write(record: ThreadRecord, signal: AbortSignal): Promise<ThreadRecord>;
}>;
const key = (entry: Pick<ThreadRecord, "channelId" | "rootId">) =>
  `${entry.channelId}:${entry.rootId}`;

export function parseThreadRecord(value: unknown): ThreadRecord {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid thread navigation record");
  const row = value as Record<string, unknown>;
  const fields = ["version", "channelId", "rootId", "title", "at", "type"];
  if (row.type === "pin") fields.push("pinned");
  if (
    row.version !== 1 ||
    typeof row.channelId !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,255}$/.test(row.channelId) ||
    typeof row.rootId !== "string" ||
    !/^[0-9a-f]{64}$/.test(row.rootId) ||
    typeof row.title !== "string" ||
    !row.title.trim() ||
    row.title.length > 160 ||
    typeof row.at !== "number" ||
    !Number.isSafeInteger(row.at) ||
    row.at < 1 ||
    (row.type !== "visit" && row.type !== "pin") ||
    (row.type === "pin" && typeof row.pinned !== "boolean") ||
    Object.keys(row).some((field) => !fields.includes(field))
  )
    throw new Error("Invalid thread navigation record");
  return row as ThreadRecord;
}

/** Opaque coordinates keep channel/message IDs inside self-encrypted content. */
export async function threadRecordCoordinate(record: ThreadRecord) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(key(record)),
  );
  const hash = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `${threadNavigationTags[record.type]}:${hash}`;
}

function project(records: readonly ThreadRecord[]): RecentThread[] {
  const rows = new Map<string, RecentThread>();
  for (const record of records) {
    const old = rows.get(key(record));
    rows.set(key(record), {
      channelId: record.channelId,
      rootId: record.rootId,
      title: record.type === "visit" || !old ? record.title : old.title,
      visitedAt: record.type === "visit" ? record.at : (old?.visitedAt ?? 0),
      ...(record.type === "pin"
        ? record.pinned && { pinned: record.at }
        : old?.pinned && { pinned: old.pinned }),
    });
  }
  return [...rows.values()]
    .filter((row) => row.visitedAt || row.pinned)
    .sort(
      (a, b) => b.visitedAt - a.visitedAt || a.rootId.localeCompare(b.rootId),
    );
}

type Snapshot = Readonly<{
  status: "idle" | "loading" | "ready" | "error" | "unsupported";
  entries: readonly RecentThread[];
  pending: readonly string[];
  error?: string | undefined;
  transient?: true | undefined;
  writeError?: string | undefined;
}>;

/** One session owns confirmed records, writes and cancellation; storage stays in the host. */
export function createThreadNavigation(
  host: ThreadNavigationHost | undefined,
  lifetime: AbortSignal,
) {
  const empty = (): Snapshot => ({
    status: host ? "idle" : "unsupported",
    entries: [],
    pending: [],
  });
  let snapshot = empty();
  let records = new Map<string, ThreadRecord>();
  let generation = new AbortController();
  let refreshing: Promise<void> | undefined;
  let queue = Promise.resolve();
  let revision = 0;
  let nextOperation = 0;
  const failed = new Map<string, ThreadRecord>();
  const pending = new Map<number, ThreadRecord>();
  const listeners = new Set<() => void>();
  const update = (patch: Partial<Snapshot> = {}) => {
    snapshot = {
      ...snapshot,
      ...patch,
      entries: project([...records.values(), ...pending.values()]),
      pending: [...new Set([...pending.values()].map(key))],
      writeError: failed.size ? "Couldn’t save thread navigation." : undefined,
    };
    for (const listener of listeners) listener();
  };
  const accept = (record: ThreadRecord) => {
    const id = `${record.type}:${key(record)}`;
    if ((records.get(id)?.at ?? 0) <= record.at) records.set(id, record);
  };
  const refresh = () => {
    if (!host || lifetime.aborted) return Promise.resolve();
    if (refreshing) return refreshing;
    const admitted = generation.signal;
    const before = revision;
    const signal = AbortSignal.any([
      lifetime,
      admitted,
      AbortSignal.timeout(10_000),
    ]);
    if (snapshot.status !== "ready")
      update({ status: "loading", error: undefined, transient: undefined });
    const operation = Promise.resolve().then(async () => {
      try {
        const loaded = await host.read(signal);
        signal.throwIfAborted();
        // A refresh begun before a confirmed mutation cannot roll it back.
        if (revision === before) records = new Map();
        for (const record of loaded) accept(record);
        update({ status: "ready", error: undefined, transient: undefined });
      } catch (error) {
        if (admitted.aborted || lifetime.aborted) return;
        update({
          status: "error",
          error: "Couldn’t sync recent threads.",
          ...(isTransientFailure(error)
            ? { transient: true }
            : { transient: undefined }),
        });
      } finally {
        if (refreshing === operation) refreshing = undefined;
      }
    });
    refreshing = operation;
    return operation;
  };
  const change = (record: ThreadRecord) => {
    if (!host || lifetime.aborted) return;
    const admitted = generation.signal;
    const operation = ++nextOperation;
    pending.set(operation, record);
    const identity = `${record.type}:${key(record)}`;
    failed.delete(identity);
    update();
    queue = queue
      .then(async () => {
        const signal = AbortSignal.any([
          lifetime,
          admitted,
          AbortSignal.timeout(20_000),
        ]);
        signal.throwIfAborted();
        const confirmed = await host.write(record, signal);
        signal.throwIfAborted();
        revision++;
        accept(confirmed);
        if ((failed.get(identity)?.at ?? 0) <= confirmed.at)
          failed.delete(identity);
      })
      .catch(() => {
        if (admitted.aborted || lifetime.aborted) return;
        if ((failed.get(identity)?.at ?? 0) < record.at)
          failed.set(identity, record);
      })
      .finally(() => {
        if (admitted.aborted || lifetime.aborted) return;
        pending.delete(operation);
        update();
      });
  };
  return {
    snapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    refresh,
    visit(root: ChannelMessage) {
      const text = (
        messagePreview([root])?.trim() ||
        root.attachments[0]?.name ||
        "Thread"
      )
        .replace(
          /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
          "\uFFFD",
        )
        .replace(/\s+/g, " ")
        .trim();
      const title =
        text.slice(0, /[\uD800-\uDBFF]/.test(text.charAt(159)) ? 159 : 160) ||
        "Thread";
      change({
        version: 1,
        type: "visit",
        channelId: root.channelId,
        rootId: root.id,
        title,
        at: Date.now(),
      });
    },
    pin(entry: RecentThread, pinned: boolean) {
      change({
        version: 1,
        type: "pin",
        channelId: entry.channelId,
        rootId: entry.rootId,
        title: entry.title,
        at: Date.now(),
        pinned,
      });
    },
    retry() {
      if (failed.size)
        for (const record of [...failed.values()]) change(record);
      else void refresh();
    },
    clear() {
      generation.abort();
      generation = new AbortController();
      revision++;
      refreshing = undefined;
      queue = Promise.resolve();
      records.clear();
      pending.clear();
      failed.clear();
      snapshot = empty();
      update();
    },
    dispose() {
      generation.abort();
      listeners.clear();
    },
  };
}
export type ThreadNavigation = ReturnType<typeof createThreadNavigation>;
