import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type {
  WorkflowCapability,
  WorkflowReference,
  WorkflowRunCursor,
  WorkflowRunPage,
  WorkflowView,
} from "../../features/workflows/types";
import {
  activePages,
  emptyRunList,
  isActiveRun,
  withNewest,
  withOlder,
  withPage,
  type WorkflowRunList,
} from "./workflowRunList";

/** The relay pushes nothing about runs, so a visible list polls its signed
 * history route. That route shares one per-person budget with every other API
 * call (300 a minute by default), so these stay a small part of it: one read
 * of the newest page per interval, plus at most `PAGES_PER_POLL` older pages
 * that still hold an active run. */
export const RUNS_ACTIVE_POLL_MS = 5_000;
export const RUNS_SETTLED_POLL_MS = 30_000;
export const RUNS_FAILED_POLL_MS = 60_000;
/** Polls in a row that may change nothing before the active interval doubles
 * with each further one, up to the settled interval. A run can wait for
 * approval for hours, and one the relay lost never ends. */
export const RUNS_QUIET_POLLS = 12;
const PAGES_PER_POLL = 2;
const activeInterval = (quiet: number) =>
  quiet < RUNS_QUIET_POLLS
    ? RUNS_ACTIVE_POLL_MS
    : Math.min(
        RUNS_SETTLED_POLL_MS,
        RUNS_ACTIVE_POLL_MS * 2 ** (quiet - RUNS_QUIET_POLLS + 1),
      );

/** True for a list under a dialog its host has open. An observer cannot see
 * that, so the host says so and the list stops polling until it is uncovered. */
export const WorkflowRunsCovered = createContext(false);

type State = Readonly<{
  list: WorkflowRunList;
  /** The newest page has been read at least once since the list was empty. */
  loaded: boolean;
  /** The last read of the newest page failed, and with what message. */
  failed: boolean;
  error: string | undefined;
  older: "idle" | "loading" | "failed";
  /** Runs the last older page added; null until one has been read. */
  added: number | null;
  /** An older page was read and the oldest run is shown. */
  ended: boolean;
  /** Polls started since a read last changed a shown run. */
  quiet: number;
  /** The relay refused a read, so the list was emptied. Until the person asks
   * again, no read puts a run back: one that was under way predates the
   * refusal. */
  denied: boolean;
}>;
type Action =
  | { type: "newest"; page: WorkflowRunPage }
  | { type: "failed"; error: string | undefined }
  | { type: "clear" }
  | { type: "denied" }
  | { type: "retry" }
  | { type: "page"; page: WorkflowRunPage }
  | { type: "polling" }
  | { type: "started" }
  | { type: "reading-older" }
  | {
      type: "older";
      cursor: WorkflowRunCursor;
      page: WorkflowRunPage | undefined;
    };

const EMPTY: State = {
  list: emptyRunList,
  loaded: false,
  failed: false,
  error: undefined,
  older: "idle",
  added: null,
  ended: false,
  quiet: 0,
  denied: false,
};
function reduce(state: State, action: Action): State {
  switch (action.type) {
    case "denied":
      return state.denied ? state : { ...EMPTY, denied: true };
    case "retry":
      return state.denied ? EMPTY : state;
    case "newest": {
      if (state.denied) return state;
      const list = withNewest(state.list, action.page);
      return {
        ...state,
        list,
        loaded: true,
        failed: false,
        error: undefined,
        // A failure to read past an end the list no longer has is over.
        older:
          state.older === "failed" && list.next !== state.list.next
            ? "idle"
            : state.older,
        ended: state.ended && !list.next,
        quiet: list === state.list ? state.quiet : 0,
      };
    }
    case "failed":
      return state.denied || (state.failed && state.error === action.error)
        ? state
        : { ...state, failed: true, error: action.error };
    // The session purged what it held; copies of it go too.
    case "clear":
      return EMPTY;
    case "page": {
      const list = withPage(state.list, action.page);
      return list === state.list ? state : { ...state, list, quiet: 0 };
    }
    // Counted as it starts, so the poll that finds a change leaves none.
    case "polling":
      return activeInterval(state.quiet) < RUNS_SETTLED_POLL_MS
        ? { ...state, quiet: state.quiet + 1 }
        : state;
    case "started":
      return state.quiet ? { ...state, quiet: 0 } : state;
    case "reading-older":
      return { ...state, older: "loading", added: null };
    case "older": {
      // A read for a cursor the list has moved on from is neither result.
      if (state.list.next !== action.cursor) return { ...state, older: "idle" };
      if (!action.page) return { ...state, older: "failed" };
      const list = withOlder(state.list, action.cursor, action.page);
      return {
        ...state,
        list,
        older: "idle",
        added: list.runs.length - state.list.runs.length,
        ended: !list.next,
      };
    }
  }
}

const documentVisible = () => document.visibilityState === "visible";
function watchDocument(listener: () => void) {
  document.addEventListener("visibilitychange", listener);
  return () => document.removeEventListener("visibilitychange", listener);
}

/** Keeps one run history current while it is on screen. `newest` and `refresh`
 * are the caller's view of the first page; older pages and re-reads of active
 * runs go through short-lived views of the same capability, so every read
 * keeps the capability's access checks and purge. */
export function useWorkflowRunList({
  capability,
  workflow,
  newest,
  refresh,
}: {
  capability: WorkflowCapability;
  workflow: WorkflowReference;
  newest: ReturnType<WorkflowView<WorkflowRunPage>["snapshot"]> | undefined;
  refresh: () => Promise<void>;
}) {
  const [state, dispatch] = useReducer(reduce, EMPTY);
  /** When the newest page was last read, or a poll last started or finished. */
  const readAt = useRef(performance.now());
  // Before paint, so a first page never shows as an empty history.
  useLayoutEffect(() => {
    if (newest?.status === "ready") {
      readAt.current = performance.now();
      dispatch({ type: "newest", page: newest.data });
    } else if (newest?.status === "error") {
      readAt.current = performance.now();
      dispatch(
        newest.denied
          ? { type: "denied" }
          : { type: "failed", error: newest.error },
      );
    } else if (newest?.status === "idle" || newest?.status === "unavailable")
      dispatch({ type: "clear" });
  }, [newest]);

  const next = state.list.next;
  const [section, setSection] = useState<HTMLElement | null>(null);
  const [end, setEnd] = useState<HTMLElement | null>(null);
  // Without an observer the list counts as on screen and the end as out of
  // reach, which leaves the explicit control.
  const [onScreen, setOnScreen] = useState(true);
  /** The cursor whose end of list was last seen in reach. Rows a page adds
   * move the end, so a sighting only counts for the cursor it was made under;
   * each new cursor is observed afresh and reports where the end is now. */
  const [reached, setReached] = useState<WorkflowRunCursor | null>(null);
  useEffect(() => {
    if (!section || typeof IntersectionObserver === "undefined") return;
    // Against the viewport: a hidden tab and a list scrolled out of any
    // ancestor read as off screen. A list under a dialog does not.
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries)
        if (entry.target === section) setOnScreen(entry.isIntersecting);
        else setReached(entry.isIntersecting ? next : null);
    });
    observer.observe(section);
    if (end) observer.observe(end);
    return () => observer.disconnect();
  }, [section, end, next]);
  const covered = useContext(WorkflowRunsCovered);
  const visible =
    useSyncExternalStore(watchDocument, documentVisible, () => true) &&
    onScreen &&
    !covered;

  // History the session cleared, or the relay refused, waits for an explicit
  // refresh.
  const live =
    !state.denied &&
    (newest?.status === "ready" ||
      newest?.status === "loading" ||
      newest?.status === "error");
  const latest = useRef({ capability, workflow, state, newest, refresh, live });
  latest.current = { capability, workflow, state, newest, refresh, live };
  const reading = useRef(new Set<WorkflowView<WorkflowRunPage>>());
  useEffect(() => {
    const views = reading.current;
    return () => {
      for (const view of views) view.dispose();
      views.clear();
    };
  }, []);
  const readPage = useCallback(async (cursor: WorkflowRunCursor) => {
    let view: WorkflowView<WorkflowRunPage>;
    try {
      view = latest.current.capability.runs(latest.current.workflow, cursor);
    } catch {
      // Access was lost, or the session is at its view limit.
      return undefined;
    }
    reading.current.add(view);
    try {
      await view.refresh();
      const snapshot = view.snapshot();
      // A refusal of any page empties the whole list.
      if (snapshot.status === "error" && snapshot.denied)
        dispatch({ type: "denied" });
      return snapshot.status === "ready" ? snapshot.data : undefined;
    } catch {
      return undefined;
    } finally {
      reading.current.delete(view);
      view.dispose();
    }
  }, []);
  /** The person asks for the newest page, which is the only way back from a
   * refusal. */
  const retry = useCallback(async () => {
    if (latest.current.state.denied) {
      // A read begun before the refusal is not an answer to this request.
      if (latest.current.newest?.status === "loading")
        await latest.current.refresh();
      dispatch({ type: "retry" });
    }
    await latest.current.refresh();
  }, []);

  const polling = useRef<Promise<void> | undefined>(undefined);
  const again = useRef(false);
  const turn = useRef(0);
  const poll = useCallback(
    (after = false) => {
      // A read under way may predate what `after` asks to be shown, so that
      // one is followed by another. A timed read just waits for it to finish.
      if (polling.current) {
        again.current ||= after;
        return polling.current;
      }
      const rounds = async () => {
        do {
          again.current = false;
          readAt.current = performance.now();
          dispatch({ type: "polling" });
          const pages = activePages(latest.current.state.list);
          const first = pages.length > PAGES_PER_POLL ? turn.current++ : 0;
          await Promise.all([
            latest.current.refresh(),
            ...pages.slice(0, PAGES_PER_POLL).map(async (_, index) => {
              const cursor = pages[(first + index) % pages.length];
              const page = cursor && (await readPage(cursor));
              if (page) dispatch({ type: "page", page });
            }),
          ]);
          // History cleared during the read is not read again unasked.
        } while (again.current && latest.current.live);
      };
      const done = rounds().finally(() => {
        polling.current = undefined;
        readAt.current = performance.now();
      });
      polling.current = done;
      return done;
    },
    [readPage],
  );

  const interval = state.failed
    ? RUNS_FAILED_POLL_MS
    : state.list.runs.some(isActiveRun)
      ? activeInterval(state.quiet)
      : RUNS_SETTLED_POLL_MS;
  const [polled, setPolled] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Each finished poll schedules the next.
  useEffect(() => {
    if (!visible || !live) return;
    // What is left of the interval since the last read: nothing after a real
    // pause, so the list catches up at once, and the rest of it after a brief
    // one. Spread a little so lists opened together do not read together.
    const wait = Math.max(
      0,
      interval * (1 + Math.random() / 10) -
        (performance.now() - readAt.current),
    );
    let current = true;
    const timer = setTimeout(
      () =>
        void poll().finally(() => {
          if (current) setPolled((count) => count + 1);
        }),
      wait,
    );
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [visible, live, interval, polled, poll]);

  // A run this person just started is shown without waiting for the next poll.
  const started = useSyncExternalStore(capability.operations.subscribe, () => {
    let request: string | undefined;
    for (const operation of capability.operations.snapshot())
      if (
        operation.action === "trigger" &&
        operation.runId &&
        operation.workflow.id === workflow.id &&
        operation.workflow.owner === workflow.owner &&
        operation.workflow.channelId === workflow.channelId
      )
        request = operation.eventId;
    return request;
  });
  const shownStart = useRef(started);
  useEffect(() => {
    if (shownStart.current === started) return;
    shownStart.current = started;
    dispatch({ type: "started" });
    if (visible && live) void poll(true);
    // Shown later, the list reads at once rather than after its interval.
    else readAt.current = Number.NEGATIVE_INFINITY;
  }, [started, visible, live, poll]);

  const readingOlder = useRef(false);
  const loadOlder = useCallback(async () => {
    const cursor = latest.current.state.list.next;
    if (!cursor || readingOlder.current) return;
    readingOlder.current = true;
    dispatch({ type: "reading-older" });
    try {
      dispatch({ type: "older", cursor, page: await readPage(cursor) });
    } finally {
      readingOlder.current = false;
    }
  }, [readPage]);
  useEffect(() => {
    if (next && reached === next && visible && state.older === "idle")
      void loadOlder();
  }, [reached, next, visible, state.older, loadOlder]);

  return {
    runs: state.list.runs,
    loaded: state.loaded,
    failed: state.failed,
    error: state.error,
    denied: state.denied,
    refresh: retry,
    /** Older runs exist that are not shown yet. */
    more: !!next,
    ended: state.ended,
    added: state.added,
    older: state.older,
    loadOlder,
    section: setSection,
    /** The list's element, once mounted. */
    region: section,
    end: setEnd,
  };
}
