/**
 * Development-only trace of channel opens: every input, UI step, relay read,
 * local step and named main-thread block, with absolute times, in one bounded
 * ring buffer that Settings → Developer → Client performance exports.
 *
 * Times are `performance.now()` values. `anchor` pairs one of them with the
 * wall clock (and `performance.timeOrigin`) so separate exports line up.
 * Events recorded while an open is pending carry its `open` id. `related`
 * says whether the event is for the opened channel (true), for another
 * channel (false) or unknown (absent).
 */

export type TraceKind = "input" | "ui" | "local" | "main" | "live" | "read";

export type TraceEvent = Readonly<{
  seq: number;
  kind: TraceKind;
  name: string;
  t: number;
  end?: number;
  open?: number;
  channel?: string;
  related?: boolean;
  data?: Readonly<Record<string, unknown>>;
}>;

/** One relay read, from the reader's queue to its consumers. */
export type TraceRead = {
  id: number;
  purpose: string;
  priority: string;
  urgent?: boolean;
  filters: readonly Readonly<Record<string, unknown>>[];
  channel?: string;
  open?: number;
  related?: boolean;
  session?: string;
  /** Reader queue entry. */
  queued: number;
  /** Got a reader slot. */
  slot?: number;
  /** The transport started the request (signing, admission and fetch). */
  sent?: number;
  /** Admitted by the HTTP admission lane (signed transport only). */
  admitted?: number;
  /** Response headers arrived: the first byte. HTTP reads have no EOSE. */
  headers?: number;
  /** Body read: the last byte, the HTTP equivalent of EOSE. */
  body?: number;
  /** Parsed and signature-checked. */
  parsed?: number;
  /** Consumers resolved. */
  done?: number;
  outcome?: string;
  bytes?: number;
  events?: number;
  /** Later callers that shared this read, with their own purpose. */
  joined?: {
    t: number;
    purpose: string;
    channel?: string | undefined;
    open?: number;
  }[];
  /** Priority or urgency raised while queued. */
  promoted?: number;
  /** Who cancelled it, when not its consumers. */
  cancelledBy?: string;
};

export type ReadHandle = Readonly<{
  id: number;
  stage(
    name: "slot" | "sent" | "admitted" | "headers" | "body" | "parsed",
  ): void;
  set(values: Partial<TraceRead>): void;
  join(purpose?: string, channel?: string): void;
  finish(outcome: string, events?: number): void;
}>;

type Cause = Readonly<{
  purpose?: string | undefined;
  channel?: string | undefined;
}>;

const NOOP_HANDLE: ReadHandle = Object.freeze({
  id: 0,
  stage() {},
  set() {},
  join() {},
  finish() {},
});

/** What a read is for, from its filters, when its caller did not say. */
export function readPurpose(
  filters: readonly Readonly<Record<string, unknown>>[],
  hint?: "read-state" | "profile-search" | "agent-library",
): string {
  if (hint) return hint;
  const kinds = new Set(
    filters.flatMap((filter) => (filter.kinds as number[] | undefined) ?? []),
  );
  const has = (...list: number[]) => list.some((kind) => kinds.has(kind));
  if (has(9, 40002) && filters.some((filter) => filter["#h"]))
    return kinds.has(40099) ? "head+notices" : "page";
  if (has(40099)) return "notices";
  if (has(0)) return has(30315) ? "names+statuses" : "names";
  if (has(30315)) return "statuses";
  if (has(30078)) return "app-data";
  if (has(39000, 39001, 39002, 39003)) return "groups";
  if (has(30617)) return "repos";
  return [...kinds].sort((a, b) => a - b).join(",") || "ids";
}

/** Filter shapes without content: kinds, counts and limits. */
export function filterShapes(
  filters: readonly Readonly<Record<string, unknown>>[],
) {
  return filters.map((filter) => {
    const shape: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(filter)) {
      if (name === "kinds" || name === "limit" || name === "since")
        shape[name] = value;
      else if (name === "until") shape.until = true;
      else if (Array.isArray(value)) shape[name] = value.length;
      else if (value !== undefined) shape[name] = true;
    }
    return Object.freeze(shape);
  });
}

export function createOpenTrace({
  enabled = true,
  now = () => performance.now(),
  limit = 20_000,
  readLimit = 4_000,
}: {
  enabled?: boolean;
  now?: () => number;
  limit?: number;
  readLimit?: number;
} = {}) {
  const events: TraceEvent[] = [];
  const reads: TraceRead[] = [];
  const inflight = new Map<number, TraceRead>();
  let seq = 0;
  let readSeq = 0;
  let openSeq = 0;
  let active: { id: number; channel: string } | undefined;
  let lastPointer: { t: number; target?: string | undefined } | undefined;
  const causes: Cause[] = [];
  let sending: ReadHandle | undefined;
  const anchor = Object.freeze({
    perf: now(),
    wall: Date.now(),
    timeOrigin:
      typeof performance === "undefined" ? undefined : performance.timeOrigin,
  });

  const tag = (channel?: string) =>
    active
      ? {
          open: active.id,
          ...(channel === undefined
            ? {}
            : { related: channel === active.channel }),
        }
      : {};
  function push(event: Omit<TraceEvent, "seq">) {
    events.push(Object.freeze({ seq: ++seq, ...event }));
    if (events.length > limit) events.splice(0, events.length - limit);
  }
  function mark(
    kind: TraceKind,
    name: string,
    data?: Record<string, unknown>,
    channel?: string,
    t = now(),
  ) {
    if (!enabled) return;
    push({
      kind,
      name,
      t,
      ...(channel ? { channel } : {}),
      ...tag(channel),
      ...(data ? { data: Object.freeze({ ...data }) } : {}),
    });
  }
  function record(
    kind: TraceKind,
    name: string,
    start: number,
    end: number,
    data?: Record<string, unknown>,
    channel?: string,
  ) {
    if (!enabled) return;
    push({
      kind,
      name,
      t: start,
      end,
      ...(channel ? { channel } : {}),
      ...tag(channel),
      ...(data ? { data: Object.freeze({ ...data }) } : {}),
    });
  }
  function span(
    kind: TraceKind,
    name: string,
    data?: Record<string, unknown>,
    channel?: string,
  ) {
    if (!enabled) return (_extra?: Record<string, unknown>) => {};
    const start = now();
    const tags = tag(channel);
    return (extra?: Record<string, unknown>) =>
      push({
        kind,
        name,
        t: start,
        end: now(),
        ...(channel ? { channel } : {}),
        ...tags,
        ...(data || extra
          ? { data: Object.freeze({ ...data, ...extra }) }
          : {}),
      });
  }
  if (enabled && typeof document !== "undefined")
    document.addEventListener(
      "pointerdown",
      (event) => {
        const target = event.target as Element | null;
        lastPointer = {
          t: event.timeStamp,
          target: target?.closest?.("[data-channel-id]")
            ? "channel-row"
            : target?.tagName?.toLowerCase(),
        };
      },
      { capture: true, passive: true },
    );

  const routes = new Map<string, string>();
  const statuses = new Map<string, string>();
  return Object.freeze({
    enabled,
    /** Live stream state per relay session: each change of its status and of
     * each channel route's status (pending until its REQ's EOSE, then live). */
    live(
      session: string,
      state: {
        status: string;
        routes: readonly { id: string; channelId?: string; status: string }[];
      },
    ) {
      if (!enabled) return;
      if (statuses.get(session) !== state.status) {
        statuses.set(session, state.status);
        mark("live", `stream.${state.status}`, { session });
      }
      for (const route of state.routes) {
        const key = `${session} ${route.id}`;
        if (routes.get(key) === route.status) continue;
        routes.set(key, route.status);
        mark(
          "live",
          `route.${route.status}`,
          { session, route: route.id },
          route.channelId,
        );
      }
    },
    mark,
    record,
    span,
    /** A channel open started: from its input event, with the pointerdown
     * that led to it when there was one. */
    begin(channel: string, trigger: string, input?: Event) {
      if (!enabled) return 0;
      const id = ++openSeq;
      active = { id, channel };
      const at = input?.timeStamp ?? now();
      if (lastPointer && at - lastPointer.t < 2_000 && at >= lastPointer.t)
        mark(
          "input",
          "pointerdown",
          { target: lastPointer.target },
          channel,
          lastPointer.t,
        );
      mark("input", input?.type ?? trigger, { trigger }, channel, at);
      return id;
    },
    /** The open ended (painted, abandoned or skipped). */
    end(outcome: string, data?: Record<string, unknown>) {
      if (!enabled || !active) return;
      mark("ui", outcome, data, active.channel);
      active = undefined;
    },
    current: () => active,
    /** Runs `work` with a cause that reads queued synchronously inside it inherit. */
    cause<T>(cause: Cause, work: () => T): T {
      if (!enabled) return work();
      causes.push(cause);
      try {
        return work();
      } finally {
        causes.pop();
      }
    },
    /** A read entered a reader's queue. */
    read(input: {
      filters: readonly Readonly<Record<string, unknown>>[];
      priority: string;
      urgent?: boolean;
      hint?: "read-state" | "profile-search" | "agent-library";
    }): ReadHandle {
      if (!enabled) return NOOP_HANDLE;
      const cause = causes.at(-1);
      const heads = input.filters
        .map((filter) => filter["#h"])
        .find((value) => Array.isArray(value) && value.length === 1) as
        | string[]
        | undefined;
      const channel = cause?.channel ?? heads?.[0];
      const entry: TraceRead = {
        id: ++readSeq,
        purpose: cause?.purpose ?? readPurpose(input.filters, input.hint),
        priority: input.priority,
        ...(input.urgent ? { urgent: true } : {}),
        filters: filterShapes(input.filters),
        ...(channel ? { channel } : {}),
        ...tag(channel),
        queued: now(),
      };
      reads.push(entry);
      if (reads.length > readLimit) reads.splice(0, reads.length - readLimit);
      inflight.set(entry.id, entry);
      return Object.freeze({
        id: entry.id,
        stage(name) {
          entry[name] ??= now();
        },
        set(values) {
          Object.assign(entry, values);
        },
        join(purpose, joinChannel) {
          const joiner = causes.at(-1);
          entry.joined ??= [];
          entry.joined.push({
            t: now(),
            purpose: joiner?.purpose ?? purpose ?? entry.purpose,
            ...((joiner?.channel ?? joinChannel)
              ? { channel: joiner?.channel ?? joinChannel }
              : {}),
            ...(active ? { open: active.id } : {}),
          });
        },
        finish(outcome, count) {
          if (entry.done !== undefined) return;
          entry.done = now();
          entry.outcome = outcome;
          if (count !== undefined) entry.events = count;
          inflight.delete(entry.id);
        },
      });
    },
    /** Runs a transport call so it can find the read it serves. */
    sending<T>(handle: ReadHandle, work: () => T): T {
      const previous = sending;
      sending = handle;
      try {
        return work();
      } finally {
        sending = previous;
      }
    },
    /** The read a transport call serves, if a reader is sending one now. */
    currentRead: (): ReadHandle => sending ?? NOOP_HANDLE,
    export() {
      return {
        version: 1,
        anchor,
        events: [...events],
        reads: reads.map((entry) => ({
          ...entry,
          ...(entry.done === undefined ? { outcome: "pending" } : {}),
        })),
      };
    },
    reset() {
      events.length = 0;
      reads.length = 0;
      for (const entry of inflight.values()) reads.push(entry);
    },
  });
}
export type OpenTrace = ReturnType<typeof createOpenTrace>;

/** Development builds only, like client metrics. */
export const openTrace = createOpenTrace({
  enabled:
    (import.meta.env?.DEV === true ||
      import.meta.env?.VITE_BUZZ_CLIENT_METRICS === "1") &&
    import.meta.env?.MODE !== "test",
});
