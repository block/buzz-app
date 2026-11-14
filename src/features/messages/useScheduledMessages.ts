import { useSyncExternalStore } from "react";
import type {
  ScheduledMessages,
  ScheduledMessage,
} from "../relay/scheduled-messages";

type Snapshot = Readonly<{
  items: readonly ScheduledMessage[];
  loading: boolean;
  error?: string | undefined;
}>;
const EMPTY: Snapshot = { items: [], loading: false };
const noop = () => {};

/** The sidebar and page share one queue read, invalidation listener and timer. */
function createStore(service: ScheduledMessages) {
  let snapshot = EMPTY;
  const listeners = new Set<() => void>();
  let request: AbortController | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stop: (() => void) | undefined;
  let retryDelay = 5000;
  const emit = (next: Snapshot) => {
    snapshot = next;
    for (const listener of listeners) listener();
  };
  function retryLater() {
    if (!listeners.size) return;
    clearTimeout(timer);
    timer = setTimeout(refresh, retryDelay * (0.8 + Math.random() * 0.4));
    retryDelay = Math.min(retryDelay * 2, 300_000);
  }
  function planRefresh() {
    clearTimeout(timer);
    if (
      snapshot.items.some(
        (item) => item.status === "scheduled" && item.sendAt <= Date.now(),
      )
    ) {
      retryLater();
      return;
    }
    retryDelay = 5000;
    const next = snapshot.items
      .filter((item) => item.status === "scheduled" && item.sendAt > Date.now())
      .sort((a, b) => a.sendAt - b.sendAt)[0];
    if (!listeners.size) return;
    // Other devices do not emit this session's invalidation event. Keep one
    // jittered long backstop, even for an empty queue.
    const backstop = 15 * 60_000 * (0.8 + Math.random() * 0.4);
    const delay = next
      ? Math.min(next.sendAt - Date.now() + 3000, backstop)
      : backstop;
    timer = setTimeout(refresh, delay);
  }
  function refresh() {
    if (!listeners.size) return;
    clearTimeout(timer);
    request?.abort();
    const controller = new AbortController();
    request = controller;
    emit({ ...snapshot, loading: true, error: undefined });
    void service.list(controller.signal).then(
      (items) => {
        if (controller.signal.aborted) return;
        request = undefined;
        emit({ items, loading: false });
        planRefresh();
      },
      (cause) => {
        if (controller.signal.aborted) return;
        request = undefined;
        emit({
          ...snapshot,
          loading: false,
          error:
            cause instanceof Error
              ? cause.message
              : "Could not load scheduled messages.",
        });
        retryLater();
      },
    );
  }
  function focused() {
    if (document.visibilityState !== "hidden") refresh();
  }
  return {
    snapshot: () => snapshot,
    refresh,
    revalidate() {
      // Opening the page shares an already-running sidebar read.
      if (!request) refresh();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      if (listeners.size === 1) {
        stop = service.subscribe(refresh);
        window.addEventListener("focus", focused);
        document.addEventListener("visibilitychange", focused);
        refresh();
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size) return;
        request?.abort();
        request = undefined;
        clearTimeout(timer);
        stop?.();
        window.removeEventListener("focus", focused);
        document.removeEventListener("visibilitychange", focused);
      };
    },
  };
}
const stores = new WeakMap<ScheduledMessages, ReturnType<typeof createStore>>();
export function useScheduledMessages(
  service: ScheduledMessages | undefined,
  active = true,
) {
  let store = service && active ? stores.get(service) : undefined;
  if (service && active && !store) {
    store = createStore(service);
    stores.set(service, store);
  }
  const snapshot = useSyncExternalStore(
    store?.subscribe ?? (() => noop),
    store?.snapshot ?? (() => EMPTY),
  );
  return {
    ...snapshot,
    refresh: store?.refresh ?? noop,
    revalidate: store?.revalidate ?? noop,
  };
}
