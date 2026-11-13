import { useCallback, useMemo, useSyncExternalStore } from "react";
import type { RelaySession } from "../../features/relay/session";
import type { EventData } from "../../features/relay/events";
import {
  REVIEW_REPORT,
  REVIEW_SUBMISSION,
} from "../../features/agents/pr-review";
import {
  applyReviewReports,
  loadSubmissions,
  type SavedSubmission,
} from "./submissions";

const selectionFallback = new Map<string, string>();
const selectionListeners = new Set<() => void>();
const selectionKey = (scope: string) => `buzz.review.channel:${scope}`;
export function useReviewChannel(scope: string) {
  const channel = useSyncExternalStore(
    (listener) => {
      selectionListeners.add(listener);
      window.addEventListener("storage", listener);
      return () => {
        selectionListeners.delete(listener);
        window.removeEventListener("storage", listener);
      };
    },
    () => {
      try {
        return (
          selectionFallback.get(scope) ??
          localStorage.getItem(selectionKey(scope)) ??
          ""
        );
      } catch {
        return selectionFallback.get(scope) ?? "";
      }
    },
  );
  const select = useCallback(
    (value: string) => {
      try {
        localStorage.setItem(selectionKey(scope), value);
        selectionFallback.delete(scope);
      } catch {
        selectionFallback.set(scope, value);
      }
      for (const listener of selectionListeners) listener();
    },
    [scope],
  );
  return [channel, select] as const;
}

export function reviewVersion(row: SavedSubmission) {
  return JSON.stringify([
    row.value.generation ?? row.value.submittedAt ?? "",
    row.value.triage?.state,
    row.value.threads.map((thread) => thread.request),
    (row.reviewReports ?? []).map((event) => event.id).sort(),
  ]);
}
type Snapshot = {
  rows: SavedSubmission[];
  loading: boolean;
  error: string;
  warning: string;
  seen: Record<string, string>;
};
const empty = (): Snapshot => ({
  rows: [],
  loading: true,
  error: "",
  warning: "",
  seen: {},
});

/** One bounded snapshot (plus report batches) for the selected channel, shared
 * by the dock and table. Live events refresh it; there is no polling. A new
 * relay session performs a jittered bounded repair after access is confirmed. */
export function createSubmissionUpdates(
  session: RelaySession,
  channel: string,
) {
  const key = `buzz.review.seen:${session.scope}:${channel}`;
  const listeners = new Set<() => void>();
  let state = empty();
  let controller: AbortController | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopLive: (() => void) | undefined;
  let pending: EventData[] = [];
  let refreshDelay = 100;
  const emit = (next: Snapshot) => {
    state = next;
    for (const listener of listeners) listener();
  };
  const readSeen = () => {
    try {
      const value: unknown = JSON.parse(localStorage.getItem(key) ?? "{}");
      if (value && typeof value === "object" && !Array.isArray(value))
        return Object.fromEntries(
          Object.entries(value).filter(([, v]) => typeof v === "string"),
        );
    } catch {
      /* Unavailable or damaged local preferences must not hide updates. */
    }
    return state.seen;
  };
  const storage = (event: StorageEvent) => {
    if (event.key === key || event.key === null)
      emit({ ...state, seen: readSeen() });
  };
  const reload = () => {
    if (!listeners.size) return;
    clearTimeout(timer);
    controller?.abort();
    const current = new AbortController();
    controller = current;
    pending = [];
    emit({ ...state, loading: true, error: "" });
    void loadSubmissions(
      session,
      channel,
      AbortSignal.any([current.signal, AbortSignal.timeout(20_000)]),
    )
      .then((next) => {
        if (current.signal.aborted) return;
        refreshDelay = 100;
        emit({
          ...state,
          ...next,
          rows: next.rows.map((row) =>
            applyReviewReports(row, channel, pending),
          ),
          loading: false,
        });
        pending = [];
      })
      .catch((reason: unknown) => {
        if (!current.signal.aborted) {
          refreshDelay = Math.min(30_000, refreshDelay * 2);
          emit({
            ...state,
            loading: false,
            error:
              reason instanceof Error
                ? reason.message
                : "Could not load previous submissions.",
          });
        }
      });
  };
  return {
    snapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      if (listeners.size === 1) {
        state = { ...state, seen: readSeen() };
        window.addEventListener("storage", storage);
        timer = setTimeout(reload, Math.random() * 250);
        stopLive = session.subscribeLive?.(
          ({ events }) => {
            const scoped = events.filter((event) =>
              event.tags.some((tag) => tag[0] === "h" && tag[1] === channel),
            );
            if (
              scoped.some(
                (event) =>
                  event.kind === 45010 &&
                  event.tags.some(
                    (tag) => tag[0] === "type" && tag[1] === REVIEW_SUBMISSION,
                  ),
              )
            ) {
              clearTimeout(timer);
              timer = setTimeout(reload, refreshDelay + Math.random() * 250);
            }
            const reports = scoped.filter(
              (event) =>
                event.kind === 9 &&
                event.tags.some(
                  (tag) => tag[0] === "t" && tag[1] === REVIEW_REPORT,
                ),
            );
            if (!reports.length) return;
            if (state.loading) pending.push(...reports);
            else
              emit({
                ...state,
                rows: state.rows.map((row) =>
                  applyReviewReports(row, channel, reports),
                ),
              });
          },
          { replay: true },
        );
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size) return;
        stopLive?.();
        controller?.abort();
        clearTimeout(timer);
        window.removeEventListener("storage", storage);
        state = empty();
      };
    },
    reload,
    setRows(update: (rows: SavedSubmission[]) => SavedSubmission[]) {
      emit({ ...state, rows: update(state.rows) });
    },
    unread(row: SavedSubmission) {
      const seen = state.seen[row.artifactId];
      return seen
        ? seen !== reviewVersion(row)
        : !!(row.reviewReports?.length || row.value.triage?.decision);
    },
    markSeen(row: SavedSubmission) {
      // Acknowledge exactly the rendered version; a newer report stays unread.
      const seen = {
        ...readSeen(),
        ...state.seen,
        [row.artifactId]: reviewVersion(row),
      };
      try {
        localStorage.setItem(key, JSON.stringify(seen));
      } catch {
        /* Acknowledgment still works for this session. */
      }
      emit({ ...state, seen });
    },
  };
}
const stores = new WeakMap<
  RelaySession,
  Map<string, ReturnType<typeof createSubmissionUpdates>>
>();
const idle = empty();
const noSubscribe = () => () => {};
export function useSubmissionUpdates(
  session: RelaySession,
  channel: string,
  enabled: boolean,
) {
  const store = useMemo(() => {
    let channels = stores.get(session);
    if (!channels) {
      channels = new Map();
      stores.set(session, channels);
    }
    let value = channels.get(channel);
    if (!value) {
      value = createSubmissionUpdates(session, channel);
      channels.set(channel, value);
    }
    return value;
  }, [session, channel]);
  const snapshot = useSyncExternalStore(
    enabled ? store.subscribe : noSubscribe,
    enabled ? store.snapshot : () => idle,
  );
  return { ...snapshot, store };
}
