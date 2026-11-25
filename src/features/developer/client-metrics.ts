/** Development session metrics, plus numeric batch/read taps for on-demand
 * agent snapshots. Development records stay in the page until exported.
 * Records are per open, request, batch or long task, never per event. */

import { openTrace } from "./open-trace";
import { runtimePerformance } from "./runtime-performance";

export type OpenTrigger = "click" | "keyboard" | "route";
/** Where the first painted rows came from. `disk-late` means the open waited,
 * then a disk restore landed before the network read did. */
export type OpenSource = "memory" | "disk" | "disk-late" | "network";
/** When each part of an open's first screen was ready, in ms from its start.
 * Absent when it never happened during the open. */
export type OpenSteps = Readonly<{
  /** The conversation pane switched to the channel. */
  pane?: number;
  /** Its rows were painted in the DOM, possibly while the screen was hidden. */
  rows?: number;
  /** The New messages line was decided: placed, or none for this visit. */
  line?: number;
  /** Every name on the rows was known. */
  names?: number;
  /** The first screen was shown. */
  shown?: number;
}>;
export type ChannelOpen = Readonly<{
  channel: string;
  trigger: OpenTrigger;
  source: OpenSource;
  /** Input event (or mount) to the first painted frame that shows its rows. */
  ms: number;
  /** Until the store held rows for the channel: a disk read or relay request.
   * Zero when the rows were already there. The rest of `ms` is rendering. */
  waitMs: number;
  steps: OpenSteps;
  at: number;
  phase: number;
}>;
export type LivePhase = {
  kind: "open" | "reconnect";
  start: number;
  /** First socket authentication in this phase, relative to `start`. */
  authMs?: number;
  /** First moment every channel route had settled (live or failed), relative to `start`. */
  coverageMs?: number;
  routes: number;
  /** Routes that settled without going live: refused, or over live capacity. */
  routeErrors: number;
  /** Pending → live, per channel route. */
  routeMs: number[];
  queries: number;
  background: number;
  bytes: number;
};
type QueryRecord = Readonly<{
  at: number;
  ms: number;
  bytes: number;
  priority: "foreground" | "background";
  ok: boolean;
  /** The relay session (HTTP origin) that served it. */
  session: string;
  phase: number;
}>;
type LongTask = Readonly<{
  start: number;
  duration: number;
}>;
type LiveRouteState = Readonly<{
  id: string;
  channelId?: string;
  status: string;
}>;
type LiveState = Readonly<{
  status: string;
  routes: readonly LiveRouteState[];
}>;

const OPEN_LIMIT = 500;
const QUERY_LIMIT = 4000;
const TASK_LIMIT = 2000;
const LAG_SAMPLE_MS = 50;
const PAINT_FRAMES = 30;

export function percentile(values: readonly number[], p: number) {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[
    Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
  ];
}
const distribution = (values: readonly number[]) => ({
  n: values.length,
  p50: percentile(values, 50),
  p90: percentile(values, 90),
  max: values.length ? Math.max(...values) : undefined,
});
/** Totals plus medians of the wait/render split. Medians of the parts need
 * not add up to the median total. */
const STEPS = ["pane", "rows", "line", "names", "shown"] as const;
const loads = (list: readonly ChannelOpen[]) => ({
  ...distribution(list.map((open) => open.ms)),
  /** Median time from the start to each step, over the opens that had it. */
  steps: Object.fromEntries(
    STEPS.map((step) => [
      step,
      percentile(
        list.flatMap((open) => open.steps[step] ?? []),
        50,
      ),
    ]),
  ) as Record<(typeof STEPS)[number], number | undefined>,
  waitP50: percentile(
    list.map((open) => open.waitMs),
    50,
  ),
  renderP50: percentile(
    list.map((open) => open.ms - open.waitMs),
    50,
  ),
});
const push = <T>(list: T[], value: T, limit: number) => {
  list.push(value);
  if (list.length > limit) list.splice(0, list.length - limit);
};
export function createClientMetrics({
  enabled = true,
  now = () => performance.now(),
  monitor = typeof window !== "undefined" && typeof document !== "undefined",
  afterPaint = (callback: () => void) => {
    if (typeof requestAnimationFrame !== "function") return callback();
    // rAF runs before the frame is painted; a task queued from it runs after.
    requestAnimationFrame(() => setTimeout(callback, 0));
  },
}: {
  enabled?: boolean;
  now?: () => number;
  /** Observe long tasks (or event-loop lag where unsupported, e.g. WebKit). */
  monitor?: boolean;
  afterPaint?: (callback: () => void) => void;
} = {}) {
  const opens: ChannelOpen[] = [];
  const queries: QueryRecord[] = [];
  const longTasks: LongTask[] = [];
  const phases: LivePhase[] = [
    {
      kind: "open",
      start: 0,
      routes: 0,
      routeErrors: 0,
      routeMs: [],
      queries: 0,
      background: 0,
      bytes: 0,
    },
  ];
  const cpu = new Map<string, { ms: number; count: number }>();
  let pending:
    | {
        channel: string;
        trigger: OpenTrigger;
        start: number;
        ensured?: "memory" | "disk" | "network";
        /** The store first held rows for the channel during this open. */
        dataAt?: number;
        dataOrigin?: "disk" | "network";
        rendered?: boolean;
        mountAt?: number;
        rowsAt?: number;
        lineAt?: number;
        namesAt?: number;
        shownAt?: number;
        /** The timeline reported its first screen hidden, so the open ends
         * only once it is shown. */
        held?: boolean;
      }
    | undefined;
  let shown: string | undefined;
  let monitoring = false;
  let everConnected = false;
  let skipped = 0;
  const routeSeen = new Map<string, number>();
  const routeDone = new Set<string>();
  let lastStatus: string | undefined;
  /** Live and read metrics follow one relay session: its phases are per
   * connection, and a retained community's socket would read as a reconnect. */
  let owner: string | undefined;
  function owns(session: string) {
    owner ??= session;
    return owner === session;
  }

  const phase = () => phases.length - 1;
  const currentPhase = () => phases[phase()] as LivePhase;
  function startMonitor() {
    if (monitoring || !monitor || !enabled) return;
    monitoring = true;
    const record = (start: number, duration: number) =>
      push(longTasks, Object.freeze({ start, duration }), TASK_LIMIT);
    if (
      typeof PerformanceObserver !== "undefined" &&
      PerformanceObserver.supportedEntryTypes?.includes("longtask")
    ) {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries())
          record(entry.startTime, entry.duration);
      }).observe({ type: "longtask", buffered: true });
      return;
    }
    // WebKit has no long-task entries. Timer lag is a coarser equivalent.
    // Hidden pages throttle timers, which is not main-thread work.
    const hidden = () => typeof document !== "undefined" && document.hidden;
    let expected = now() + LAG_SAMPLE_MS;
    if (typeof document !== "undefined")
      document.addEventListener("visibilitychange", () => {
        expected = now() + LAG_SAMPLE_MS;
      });
    setInterval(() => {
      const current = now();
      const lag = current - expected;
      if (lag >= LAG_SAMPLE_MS && !hidden()) record(expected, lag);
      expected = current + LAG_SAMPLE_MS;
    }, LAG_SAMPLE_MS);
  }
  const active = <A extends unknown[], R>(work: (...args: A) => R) =>
    ((...args: A) => {
      if (!enabled) return undefined;
      startMonitor();
      return work(...args);
    }) as (...args: A) => R | undefined;

  function finishOpen() {
    const open = pending;
    if (!open) return;
    pending = undefined;
    const at = now();
    openTrace.end("painted", { ms: at - open.start });
    // Rows the store already held keep their origin; otherwise they arrived
    // during the open.
    const source: OpenSource =
      open.ensured === "memory" || open.ensured === "disk"
        ? open.ensured
        : open.dataOrigin === "disk"
          ? "disk-late"
          : open.dataOrigin || open.ensured
            ? "network"
            : "memory";
    push(
      opens,
      Object.freeze({
        channel: open.channel.slice(0, 8),
        trigger: open.trigger,
        source,
        ms: at - open.start,
        waitMs: Math.max(0, (open.dataAt ?? open.start) - open.start),
        steps: Object.freeze(
          Object.fromEntries(
            (
              [
                ["pane", open.mountAt],
                ["rows", open.rowsAt],
                ["line", open.lineAt],
                ["names", open.namesAt],
                ["shown", open.shownAt],
              ] as const
            ).flatMap(([step, t]) =>
              t === undefined ? [] : [[step, Math.max(0, t - open.start)]],
            ),
          ),
        ),
        at: open.start,
        phase: phase(),
      }),
      OPEN_LIMIT,
    );
  }

  function summary() {
    const hits = opens.filter(
      (open) => open.source === "memory" || open.source === "disk",
    );
    const bySource = Object.fromEntries(
      (["memory", "disk", "disk-late", "network"] as const).map((source) => [
        source,
        loads(opens.filter((open) => open.source === source)),
      ]),
    ) as Record<OpenSource, ReturnType<typeof loads>>;
    return {
      opens: {
        ...distribution(opens.map((open) => open.ms)),
        cacheHitRate: opens.length ? hits.length / opens.length : undefined,
        /** Opens dropped because nothing painted: empty, failed or scrolled away. */
        skipped,
        bySource,
      },
      mainThread: {
        longTasks: longTasks.length,
        longTaskMs: longTasks.reduce((sum, task) => sum + task.duration, 0),
        cpu: Object.fromEntries(cpu),
      },
      phases: phases.map((entry) => ({
        ...entry,
        routeMs: distribution(entry.routeMs),
      })),
    };
  }

  return Object.freeze({
    enabled,
    /** A user asked to open a channel; timing starts at the input event.
     * Keyboard activation of a button arrives as a click with no pointer detail. */
    channelIntent: active((channel: string, input?: Event) => {
      // Reselecting the channel on screen renders nothing new.
      if (channel === shown) return;
      const keyboard =
        input?.type.startsWith("key") ||
        (input?.type === "click" && (input as MouseEvent).detail === 0);
      const trigger = !input ? "route" : keyboard ? "keyboard" : "click";
      pending = { channel, trigger, start: input?.timeStamp ?? now() };
      openTrace.begin(channel, trigger, input);
    }),
    /** The conversation pane switched channels. A switch without an intent is a route. */
    channelMounted: active((channel: string) => {
      if (channel === shown) return;
      shown = channel;
      if (pending?.channel !== channel) {
        pending = { channel, trigger: "route", start: now() };
        openTrace.begin(channel, "route");
      }
      if (pending.mountAt === undefined)
        openTrace.mark("ui", "pane", {}, channel);
      pending.mountAt ??= now();
    }),
    /** The pane stopped showing a channel (switched, or replaced by another
     * page). Returning to it is a new open, and its unfinished open is dropped
     * unless the pane remounts at once (React StrictMode replays effects). */
    channelUnmounted: active((channel: string) => {
      if (shown !== channel) return;
      shown = undefined;
      const open = pending;
      queueMicrotask(() => {
        if (
          shown !== channel &&
          pending === open &&
          open?.channel === channel
        ) {
          pending = undefined;
          openTrace.end("abandoned");
        }
      });
    }),
    /** The store's view of the demanded window when it was ensured. The pane
     * may already have rendered rows it held, before its effect ensured it. */
    channelEnsured: active(
      (channel: string, source: "memory" | "disk" | "network") => {
        if (pending?.channel === channel && !pending.ensured) {
          pending.ensured = source;
          openTrace.mark("local", "ensured", { source }, channel);
        }
      },
    ),
    /** The store first holds rows for a channel whose window was empty. */
    channelData: active((channel: string, origin: "disk" | "network") => {
      if (pending?.channel !== channel || pending.rendered) return;
      if (pending.dataAt === undefined)
        openTrace.mark("local", "data", { origin }, channel);
      pending.dataAt ??= now();
      pending.dataOrigin ??= origin;
    }),
    /** Message rows were committed for a channel. Records after the first
     * paint in which `visible` holds (a virtualized list may need a frame). */
    channelRendered: active(
      (channel: string, visible: () => boolean = () => true) => {
        const open = pending;
        if (open?.channel !== channel || open.rendered) return;
        open.rendered = true;
        let frames = 0;
        const check = () => {
          if (pending !== open || shown !== channel) return;
          if (visible()) {
            open.rowsAt = now();
            openTrace.mark(
              "ui",
              "rows",
              { hidden: !!open.held && open.shownAt === undefined, frames },
              channel,
            );
            // A hidden first screen ends the open when it is shown.
            if (!open.held || open.shownAt !== undefined) finishOpen();
          } else if (++frames < PAINT_FRAMES) afterPaint(check);
          else {
            // Recording now would time the fallback, not the paint.
            pending = undefined;
            skipped++;
            openTrace.end("skipped", { reason: "rows never visible" });
          }
        };
        afterPaint(check);
      },
    ),
    /** The timeline's first screen: whether its line is decided, its names
     * are known and it is shown. Reported from its first commit, before the
     * pane reports rendered rows, so a hidden screen holds the open. */
    channelScreen: active(
      (
        channel: string,
        screen: { line: boolean; names: boolean; shown: boolean },
      ) => {
        const open = pending;
        if (open?.channel !== channel) return;
        const at = now();
        if (screen.line && open.lineAt === undefined)
          openTrace.mark("ui", "line", {}, channel, at);
        if (screen.names && open.namesAt === undefined)
          openTrace.mark("ui", "names", {}, channel, at);
        if (screen.line) open.lineAt ??= at;
        if (screen.names) open.namesAt ??= at;
        if (!screen.shown) {
          open.held ??= true;
          return;
        }
        if (open.shownAt !== undefined) return;
        open.shownAt = at;
        openTrace.mark("ui", "shown", {}, channel, at);
        // Rows already painted hidden: the open ends with the next paint.
        if (open.rowsAt !== undefined)
          afterPaint(() => {
            if (pending === open && shown === channel) finishOpen();
          });
      },
    ),
    /** The channel settled with nothing to paint (empty or failed), so its
     * pending open would otherwise time the first message or a retry. */
    channelEmpty: active((channel: string) => {
      if (pending?.channel !== channel || pending.rendered) return;
      pending = undefined;
      skipped++;
      openTrace.end("skipped", { reason: "empty" });
    }),
    /** A finite relay read finished. One call per request, never per event.
     * `session` names the relay session; only the first one seen is recorded. */
    query(
      session: string,
      input: {
        ms: number;
        bytes: number;
        priority: "foreground" | "background";
        ok: boolean;
      },
    ) {
      runtimePerformance.read(input);
      if (!enabled) return;
      startMonitor();
      // Every session's reads are kept; the phase counts only its own.
      push(
        queries,
        Object.freeze({ ...input, session, at: now(), phase: phase() }),
        QUERY_LIMIT,
      );
      if (!owns(session)) return;
      const current = currentPhase();
      current.queries++;
      current.bytes += input.bytes;
      if (input.priority === "background") current.background++;
    },
    /** Synchronous main-thread work measured by its caller, per batch. */
    cpu(stage: string, ms: number, count: number) {
      runtimePerformance.work(stage, ms, count);
      if (!enabled) return;
      const end = now();
      openTrace.record("main", stage, end - ms, end, { count });
      startMonitor();
      const entry = cpu.get(stage) ?? { ms: 0, count: 0 };
      entry.ms += ms;
      entry.count += count;
      cpu.set(stage, entry);
    },
    /** Observe live route state; derives connect/reconnect phases and coverage. */
    live: active((session: string, state: LiveState) => {
      if (!owns(session)) return;
      const at = now();
      const reconnecting =
        everConnected &&
        (state.status === "retrying" || state.status === "connecting") &&
        (lastStatus === "connected" || lastStatus === "error");
      lastStatus = state.status;
      if (reconnecting) {
        phases.push({
          kind: "reconnect",
          start: at,
          routes: 0,
          routeErrors: 0,
          routeMs: [],
          queries: 0,
          background: 0,
          bytes: 0,
        });
        if (phases.length > 64) phases.splice(1, 1);
        routeSeen.clear();
        routeDone.clear();
      }
      const current = currentPhase();
      if (
        current.kind === "open" &&
        !current.start &&
        state.status === "connecting"
      )
        current.start = at;
      if (state.status !== "connected") return;
      everConnected = true;
      current.authMs ??= at - current.start;
      const channels = state.routes.filter((route) => route.channelId);
      for (const route of channels) {
        if (!routeSeen.has(route.id)) {
          // A join or new DM after coverage is not setup cost.
          if (current.coverageMs !== undefined) continue;
          routeSeen.set(route.id, at);
        }
        if (route.status === "live" && !routeDone.has(route.id)) {
          routeDone.add(route.id);
          current.routeMs.push(at - (routeSeen.get(route.id) ?? at));
        }
      }
      // Only the first time every route settles counts; later resubscribes
      // would otherwise overwrite the phase's coverage.
      if (
        current.coverageMs === undefined &&
        channels.length > 0 &&
        channels.every((route) =>
          ["live", "error", "limited"].includes(route.status),
        )
      ) {
        current.coverageMs = at - current.start;
        current.routes = channels.length;
        current.routeErrors = channels.filter(
          (route) => route.status !== "live",
        ).length;
      }
    }),
    summary,
    export(label = "") {
      return {
        version: 1,
        label,
        exportedAt: new Date().toISOString(),
        userAgent:
          typeof navigator === "undefined" ? undefined : navigator.userAgent,
        summary: summary(),
        opens: [...opens],
        queries: [...queries],
        longTasks: [...longTasks],
        trace: openTrace.export(),
      };
    },
    reset() {
      openTrace.reset();
      opens.length = 0;
      queries.length = 0;
      longTasks.length = 0;
      cpu.clear();
      skipped = 0;
      // Keep `shown`: the pane still shows it, and reselecting it opens nothing.
      pending = undefined;
      // Keep the current phase and its coverage; reset only its counters.
      const current = currentPhase();
      phases.splice(0, phases.length, {
        ...current,
        queries: 0,
        background: 0,
        bytes: 0,
      });
    },
  });
}
export type ClientMetrics = ReturnType<typeof createClientMetrics>;

/** Development builds only; production and unit tests get a no-op recorder. */
export const clientMetrics = createClientMetrics({
  enabled:
    (import.meta.env?.DEV === true ||
      import.meta.env?.VITE_BUZZ_CLIENT_METRICS === "1") &&
    import.meta.env?.MODE !== "test",
});
if (clientMetrics.enabled)
  (globalThis as { __buzzClientMetrics?: ClientMetrics }).__buzzClientMetrics =
    clientMetrics;
