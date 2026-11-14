import { isTransientFailure } from "./errors";
import { MESSAGE_CONTENT_KINDS, messageContentKind } from "./channel-kinds";
import { RECOVERY_DELAYS_MS, type RecoverySource } from "./recovery";
import type { RelayEvent } from "./events";
import type { RelayReader } from "./reader";
import { retryRead } from "./read-retry";
import { threadReference } from "./thread-reference";
import type { ChannelWindow } from "./contracts";

export type LatestMessage = Readonly<{
  id: string;
  createdAt: number;
  authorId: string;
  content: string;
}>;
type Evidence = {
  asked: boolean;
  failed?: boolean;
  complete: boolean;
  empty: boolean;
  /** A completed empty read supersedes this older canonical observation. */
  superseded?: string | undefined;
};

/** A verified head can answer a preview without another finite read. */
const verifiedHeads = new WeakMap<
  ChannelWindow,
  LatestMessage | null | undefined
>();
export function loadedPreview(
  window: ChannelWindow,
): LatestMessage | null | undefined {
  if (
    window.status !== "ready" ||
    window.freshness !== "verified" ||
    window.hasNewer ||
    window.refreshing
  )
    return undefined;
  if (verifiedHeads.has(window)) return verifiedHeads.get(window);
  let newest: LatestMessage | undefined;
  for (const row of window.rows) {
    if (row.threadRootId || row.delivery || row.audience === "agents") continue;
    if (
      !newest ||
      row.createdAt > newest.createdAt ||
      (row.createdAt === newest.createdAt && row.id < newest.id)
    )
      newest = row;
  }
  const result = newest ?? (window.rows.length ? undefined : null);
  verifiedHeads.set(window, result);
  return result;
}

/** Demand/read evidence only. Message bodies always come from the session's
 * canonical projections, never a second raw-event cache in a list component. */
export function createChannelPreviews({
  read,
  latest,
  loaded,
  readable,
  notify,
}: {
  read: RelayReader["read"] | undefined;
  latest(id: string): LatestMessage | null | undefined;
  loaded(id: string): LatestMessage | null | undefined;
  readable(id: string): boolean;
  notify(listener: () => void): void;
}) {
  const demand = new Map<string, number>();
  const evidence = new Map<string, Evidence>();
  const listeners = new Set<() => void>();
  let snapshot: ReadonlyMap<string, LatestMessage | null> = new Map();
  let active:
    | { ids: readonly string[]; controller: AbortController }
    | undefined;
  let closed = false;
  let scheduled: ReturnType<typeof setTimeout> | undefined;
  const announce = () => {
    for (const listener of listeners) notify(listener);
  };
  const same = (
    a: LatestMessage | null | undefined,
    b: LatestMessage | null | undefined,
  ) =>
    a === b ||
    (!!a &&
      !!b &&
      a.id === b.id &&
      a.createdAt === b.createdAt &&
      a.authorId === b.authorId &&
      a.content === b.content);
  function publish(repair = false) {
    if (closed) return;
    const next = new Map<string, LatestMessage | null>();
    for (const [id, held] of evidence) {
      if (!readable(id)) {
        evidence.delete(id);
        continue;
      }
      const head = latest(id);
      if (head && head.id !== held.superseded) next.set(id, head);
      else if (head === null || held.empty) next.set(id, null);
      else if (
        repair &&
        snapshot.get(id) &&
        demand.has(id) &&
        !active?.ids.includes(id)
      ) {
        held.asked = false;
        held.complete = false;
      }
    }
    if (
      next.size !== snapshot.size ||
      [...next].some(([id, value]) => !same(snapshot.get(id), value))
    ) {
      snapshot = next;
      announce();
    }
  }
  function prune() {
    // Keep completed read evidence for nearby/revisited rows, bounded while idle.
    for (const id of evidence.keys()) {
      if (evidence.size <= 512) break;
      if (!demand.has(id)) evidence.delete(id);
    }
  }
  async function drain() {
    if (closed || active || !read) return;
    const ids: string[] = [];
    for (const id of demand.keys()) {
      if (!readable(id)) continue;
      const held = evidence.get(id) ?? {
        asked: false,
        complete: false,
        empty: false,
      };
      evidence.set(id, held);
      if (held.asked) continue;
      held.asked = true;
      const head = loaded(id);
      if (head !== undefined) {
        held.complete = true;
        held.empty = head === null;
        held.superseded = undefined;
      } else ids.push(id);
      // The shared reader accepts at most four ordinary filters per request.
      if (ids.length === 4) break;
    }
    publish();
    if (!ids.length) {
      announce();
      return;
    }
    const controller = new AbortController();
    active = { ids, controller };
    announce();
    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(10_000),
    ]);
    try {
      const events = await retryRead(
        (signal) =>
          read(
            ids.map((id) => ({
              kinds: MESSAGE_CONTENT_KINDS,
              "#h": [id],
              limit: 1,
              top_level: true,
              include_aux: true,
            })),
            { signal, priority: "background" },
          ),
        signal,
      );
      signal.throwIfAborted();
      if (closed) return;
      for (const id of ids) {
        const held = evidence.get(id);
        if (!held) continue;
        held.asked = true;
        held.complete = true;
        held.failed = false;
        held.empty = !events.some(
          (event) =>
            messageContentKind(event.kind) &&
            !threadReference(event) &&
            event.tags.some(([name, value]) => name === "h" && value === id),
        );
        held.superseded = held.empty ? latest(id)?.id : undefined;
      }
      publish();
    } catch (error) {
      for (const id of ids) {
        const held = evidence.get(id);
        if (!held) continue;
        if (controller.signal.aborted || !demand.has(id)) held.asked = false;
        else held.failed = signal.aborted || isTransientFailure(error);
      }
    } finally {
      active = undefined;
      announce();
      void drain();
    }
  }
  function schedule() {
    if (closed) return;
    if (active && !active.ids.some((id) => demand.has(id)))
      active.controller.abort();
    if (!demand.size) {
      clearTimeout(scheduled);
      scheduled = undefined;
      announce();
      return;
    }
    if (scheduled !== undefined) return;
    // Spread initial demand across clients. Subsequent batches share this one
    // drain; exhausted reads return through session recovery, never a tight loop.
    scheduled = setTimeout(
      () => {
        scheduled = undefined;
        if (closed) return;
        if (active && !active.ids.some((id) => demand.has(id)))
          active.controller.abort();
        void drain();
      },
      (RECOVERY_DELAYS_MS[0] ?? 1_000) * (0.25 + Math.random() / 4),
    );
  }
  const retry = () => {
    for (const [id, held] of evidence)
      if (demand.has(id) && !held.complete && !active?.ids.includes(id)) {
        held.asked = false;
        held.failed = false;
      }
    schedule();
    announce();
  };
  const recovery: RecoverySource = {
    status: () =>
      active || scheduled !== undefined
        ? "busy"
        : [...evidence].some(([id, held]) => demand.has(id) && held.failed)
          ? "failed"
          : "settled",
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    retry,
    reauthorize: retry,
  };
  const changed = (_events?: readonly RelayEvent[]) => {
    publish(true);
    schedule();
  };
  return {
    recovery,
    capability: {
      snapshot: () => snapshot,
      subscribe(listener: () => void) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      retain(wanted: readonly string[]) {
        if (closed) return () => {};
        const ids = [...new Set(wanted)];
        for (const id of ids) {
          demand.set(id, (demand.get(id) ?? 0) + 1);
          const head = loaded(id);
          if (head !== undefined && !active?.ids.includes(id))
            evidence.set(id, {
              asked: true,
              complete: true,
              empty: head === null,
            });
          const held = evidence.get(id);
          if (
            held &&
            !held.empty &&
            !active?.ids.includes(id) &&
            latest(id) === undefined
          )
            held.asked = false;
        }
        publish();
        schedule();
        return () => {
          for (const id of ids) {
            const count = (demand.get(id) ?? 1) - 1;
            if (count) demand.set(id, count);
            else {
              demand.delete(id);
              const held = evidence.get(id);
              if (held && !held.complete) held.asked = false;
            }
          }
          prune();
          publish();
          schedule();
        };
      },
    },
    changed,
    clear() {
      active?.controller.abort();
      evidence.clear();
      publish();
      schedule();
    },
    dispose() {
      closed = true;
      clearTimeout(scheduled);
      active?.controller.abort();
      demand.clear();
      evidence.clear();
      snapshot = new Map();
      listeners.clear();
    },
  };
}
