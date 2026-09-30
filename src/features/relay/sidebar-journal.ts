import {
  sidebarOperation,
  type ReadIntent,
  type IntentOutcome,
} from "./sidebar-api";

export type UnreadTarget =
  | { kind: "channel"; channelId: string }
  | { kind: "thread"; channelId: string; rootId: string }
  | { kind: "message"; channelId: string; messageId: string };
export type SidebarManualTarget =
  | UnreadTarget
  | { kind: "message-force"; channelId: string };
export const unreadTargetKey = (target: SidebarManualTarget) =>
  `${target.channelId}:${target.kind}:${target.kind === "thread" ? target.rootId : target.kind === "message" ? target.messageId : ""}`;
export type AnchoredRead = { intent: ReadIntent; createdAt: number };
export type PendingRead = AnchoredRead & { id: string };
export type SidebarJournal = {
  pending: PendingRead[];
  manual: SidebarManualTarget[];
};
export interface SidebarStorage {
  /** Strict, cross-window atomic transaction. No remote side effects inside change. */
  update(
    change: (current: SidebarJournal) => SidebarJournal,
  ): Promise<SidebarJournal>;
  close(): void;
}
export type ReadMutationResult = {
  operationId: string;
  durability: "saved";
  sync: "pending" | "local-only";
};
const empty = (): SidebarJournal => ({ pending: [], manual: [] });
function validate(value: SidebarJournal): SidebarJournal {
  if (
    !value ||
    !Array.isArray(value.pending) ||
    !Array.isArray(value.manual) ||
    value.pending.length > 1000 ||
    value.manual.length > 1000
  )
    throw new Error("Read journal exceeds capacity or is invalid");
  const operations = new Set<string>(),
    targets = new Set<string>();
  for (const p of value.pending) {
    if (
      !p ||
      typeof p.id !== "string" ||
      p.id.length > 64 ||
      !p.id ||
      operations.has(p.id) ||
      !Number.isSafeInteger(p.createdAt) ||
      p.createdAt < 0
    )
      throw new Error("Invalid pending read");
    operations.add(p.id);
    sidebarOperation({ type: "write", intents: [p.intent] });
  }
  for (const t of value.manual) {
    if (
      !t ||
      !["channel", "thread", "message", "message-force"].includes(t.kind)
    )
      throw new Error("Invalid manual unread");
    sidebarOperation({
      type: "contexts",
      targets: [
        {
          target: {
            channel_id: t.channelId,
            ...(t.kind === "thread" ? { root_id: t.rootId } : {}),
          },
          message_ids: t.kind === "message" ? [t.messageId] : [],
        },
      ],
    });
    const key = unreadTargetKey(t);
    if (targets.has(key)) throw new Error("Duplicate manual unread");
    targets.add(key);
  }
  if (new TextEncoder().encode(JSON.stringify(value)).length > 512 * 1024)
    throw new Error("Read journal exceeds capacity");
  return value;
}
function dominates(a: AnchoredRead, b: AnchoredRead) {
  const x = a.intent,
    y = b.intent;
  // A discrete snapshot is never a context prefix, in either direction.
  if (x.type === "mark_messages_read" || y.type === "mark_messages_read")
    return false;
  const channel = (i: ReadIntent) =>
    i.type === "mark_through" ? i.target.channel_id : i.channel_id;
  return (
    a.createdAt >= b.createdAt &&
    channel(x) === channel(y) &&
    (x.type === "mark_channel_read" ||
      (y.type === "mark_through" && x.target.root_id === y.target.root_id))
  );
}
export function browserSidebarStorage(scope: string): SidebarStorage {
  let database: Promise<IDBDatabase> | undefined;
  let closed = false;
  function open() {
    if (closed) return Promise.reject(new Error("Read journal closed"));
    if (database) return database;
    const promise = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("buzz-sidebar-v1", 1);
      request.onupgradeneeded = () =>
        request.result.createObjectStore("partitions");
      let failed = false;
      const fail = (error: unknown) => {
        failed = true;
        if (database === promise) database = undefined;
        reject(error);
      };
      request.onsuccess = () => {
        if (failed || closed) {
          request.result.close();
          if (closed) fail(new Error("Read journal closed"));
          return;
        }
        request.result.onversionchange = () => {
          if (database === promise) database = undefined;
          request.result.close();
        };
        resolve(request.result);
      };
      request.onerror = () => fail(request.error);
      request.onblocked = () =>
        fail(new Error("Close other Buzz windows to open read state"));
    });
    database = promise;
    return promise;
  }
  return {
    async update(change) {
      const db = await open();
      if (closed) throw new Error("Read journal closed");
      return new Promise((resolve, reject) => {
        const tx = db.transaction("partitions", "readwrite", {
          durability: "strict",
        });
        const store = tx.objectStore("partitions");
        const get = store.get(scope);
        let result: SidebarJournal, error: unknown;
        get.onsuccess = () => {
          try {
            result = validate(
              change(get.result === undefined ? empty() : validate(get.result)),
            );
            store.put(result, scope);
          } catch (cause) {
            error = cause;
            tx.abort();
          }
        };
        tx.oncomplete = () => resolve(result);
        tx.onabort = () =>
          reject(error ?? tx.error ?? new Error("Read journal save aborted"));
        tx.onerror = () => reject(tx.error);
      });
    },
    close() {
      closed = true;
      void database?.then(
        (db) => db.close(),
        () => {},
      );
    },
  };
}

/** Fixed operands need no publisher lock: duplicate sends converge on the relay.
 * Each acknowledgement removes only its own captured operation IDs. */
export function createSidebarJournal(
  storage: SidebarStorage,
  changed: () => void,
) {
  let current = empty();
  let closed = false;
  let serial: Promise<unknown> = Promise.resolve();
  function update(change: (journal: SidebarJournal) => SidebarJournal) {
    const work = serial.then(async () => {
      if (closed) throw new Error("Read journal closed");
      const result = await storage.update((journal) => {
        if (closed) throw new Error("Read journal closed");
        return validate(change(journal));
      });
      if (!closed) {
        current = result;
        changed();
      }
      return result;
    });
    serial = work.catch(() => {});
    return work;
  }
  return {
    snapshot: () => current,
    reload: () => update((j) => j),
    manual: (target: SidebarManualTarget) =>
      current.manual.some(
        (t) => unreadTargetKey(t) === unreadTargetKey(target),
      ),
    async markUnread(
      target: SidebarManualTarget,
      valid: () => boolean,
    ): Promise<ReadMutationResult> {
      const operationId = crypto.randomUUID();
      await update((j) => {
        if (!valid()) throw new Error("Reading context changed");
        return {
          ...j,
          manual: [
            ...j.manual.filter(
              (t) => unreadTargetKey(t) !== unreadTargetKey(target),
            ),
            target,
          ],
        };
      });
      return { operationId, durability: "saved", sync: "local-only" };
    },
    async enqueue(
      intents: AnchoredRead[],
      clear: (target: SidebarManualTarget) => boolean,
      valid: () => boolean,
    ): Promise<ReadMutationResult> {
      const pending = intents.map((anchor) => ({
        ...anchor,
        id: crypto.randomUUID(),
      }));
      const operationId = pending[0]?.id ?? crypto.randomUUID();
      await update((j) => {
        if (!valid()) throw new Error("Reading context changed");
        return {
          pending: pending.reduce((all, next) => {
            if (all.some((p) => dominates(p, next))) return all;
            return [...all.filter((p) => !dominates(next, p)), next];
          }, j.pending),
          manual: j.manual.filter((t) => !clear(t)),
        };
      });
      return {
        operationId,
        durability: "saved",
        sync: pending.length ? "pending" : "local-only",
      };
    },
    async acknowledge(batch: PendingRead[], outcomes: IntentOutcome[]) {
      if (batch.length !== outcomes.length)
        throw new Error("Read outcomes do not match intent");
      const resolved = new Set(
        batch
          .filter((_, i) => outcomes[i]?.status !== "unknown")
          .map((p) => p.id),
      );
      await update((j) => ({
        ...j,
        pending: j.pending.filter((p) => !resolved.has(p.id)),
      }));
    },
    dispose() {
      closed = true;
      storage.close();
    },
  };
}
