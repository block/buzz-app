import { afterEach, expect, it, vi } from "vitest";
import { clientMetrics, createClientMetrics } from "./client-metrics";

afterEach(() => vi.useRealTimers());
function setup(options: Parameters<typeof createClientMetrics>[0] = {}) {
  let time = 0;
  const frames: (() => void)[] = [];
  const metrics = createClientMetrics({
    now: () => time,
    monitor: false,
    afterPaint: (callback) => frames.push(callback),
    ...options,
  });
  return {
    metrics,
    advance(ms: number) {
      time += ms;
    },
    paint() {
      for (const frame of frames.splice(0)) frame();
    },
  };
}
const click = (timeStamp: number, detail = 1) =>
  ({ type: "click", detail, timeStamp }) as unknown as Event;

it("times an open from its input event to the painted frame and classifies its source", () => {
  const h = setup();
  h.advance(100);
  h.metrics.channelIntent("alpha-channel", click(90));
  h.metrics.channelMounted("alpha-channel");
  h.metrics.channelEnsured("alpha-channel", "network");
  h.advance(200);
  h.metrics.channelRendered("alpha-channel", "verified");
  h.advance(16);
  h.paint();
  // Keyboard activation, rows already in memory before the store is asked.
  h.metrics.channelIntent("beta-channel", click(310, 0));
  h.metrics.channelMounted("beta-channel");
  h.metrics.channelRendered("beta-channel", "verified");
  h.metrics.channelEnsured("beta-channel", "network"); // too late to matter
  h.advance(10);
  h.paint();
  // Route switch, disk restore landing while the network read was pending.
  h.metrics.channelMounted("gamma-channel");
  h.metrics.channelEnsured("gamma-channel", "network");
  h.advance(40);
  h.metrics.channelRendered("gamma-channel", "cached");
  h.paint();
  const { opens } = h.metrics.export();
  expect(opens).toEqual([
    expect.objectContaining({
      channel: "alpha-ch",
      trigger: "click",
      source: "network",
      ms: 226,
    }),
    expect.objectContaining({
      channel: "beta-cha",
      trigger: "keyboard",
      source: "memory",
      ms: 16,
    }),
    expect.objectContaining({
      channel: "gamma-ch",
      trigger: "route",
      source: "disk-late",
      ms: 40,
    }),
  ]);
  const summary = h.metrics.summary();
  expect(summary.opens.cacheHitRate).toBeCloseTo(1 / 3);
  expect(summary.opens.bySource.network.n).toBe(1);
});

it("waits for the rows to be visible, ignores reselecting the shown channel and supersedes abandoned opens", () => {
  const h = setup();
  h.metrics.channelMounted("alpha");
  let visible = false;
  h.metrics.channelRendered("alpha", "cached", () => visible);
  h.advance(16);
  h.paint();
  expect(h.metrics.export().opens).toEqual([]);
  visible = true;
  h.advance(16);
  h.paint();
  expect(h.metrics.export().opens).toEqual([
    expect.objectContaining({ source: "disk", ms: 32 }),
  ]);
  h.metrics.channelIntent("alpha", click(40));
  h.metrics.channelRendered("alpha", "verified");
  h.paint();
  h.metrics.channelIntent("beta", click(50));
  h.metrics.channelIntent("gamma", click(60));
  h.metrics.channelMounted("gamma");
  h.metrics.channelRendered("beta", "verified");
  h.metrics.channelRendered("gamma", "verified");
  h.paint();
  expect(h.metrics.export().opens.map((open) => open.channel)).toEqual([
    "alpha",
    "gamma",
  ]);
});

it("derives open and reconnect phases, live coverage and per-phase read cost", () => {
  const h = setup();
  const routes = (status: string, count = 3) =>
    Array.from({ length: count }, (_, i) => ({
      id: `channel:${i}`,
      channelId: String(i),
      status,
    }));
  h.advance(5);
  h.metrics.live({ status: "connecting", routes: [] });
  h.advance(50);
  h.metrics.live({ status: "connected", routes: routes("pending") });
  h.metrics.query({ ms: 10, bytes: 1000, priority: "foreground", ok: true });
  h.advance(30);
  h.metrics.live({
    status: "connected",
    routes: [
      ...routes("live", 2),
      { id: "channel:2", channelId: "2", status: "pending" },
    ],
  });
  h.advance(20);
  h.metrics.live({ status: "connected", routes: routes("live") });
  h.advance(1000);
  h.metrics.live({ status: "retrying", routes: routes("pending") });
  h.metrics.query({ ms: 10, bytes: 500, priority: "background", ok: true });
  h.advance(100);
  h.metrics.live({
    status: "connected",
    routes: [
      ...routes("live", 2),
      { id: "channel:2", channelId: "2", status: "error" },
    ],
  });
  const [open, reconnect] = h.metrics.summary().phases;
  expect(open).toMatchObject({
    kind: "open",
    start: 5,
    authMs: 50,
    coverageMs: 100,
    routes: 3,
    routeErrors: 0,
    routeMs: { n: 3, p50: 30, max: 50 },
    queries: 1,
    background: 0,
    bytes: 1000,
  });
  expect(reconnect).toMatchObject({
    kind: "reconnect",
    authMs: 100,
    coverageMs: 100,
    routes: 3,
    routeErrors: 1,
    routeMs: { n: 2 },
    queries: 1,
    background: 1,
    bytes: 500,
  });
});

it("keeps a phase's first coverage when routes later resubscribe or are added", () => {
  const h = setup();
  const route = (i: number, status: string) => ({
    id: `channel:${i}`,
    channelId: String(i),
    status,
  });
  h.metrics.live({ status: "connecting", routes: [] });
  h.advance(10);
  h.metrics.live({ status: "connected", routes: [route(0, "pending")] });
  h.advance(40);
  h.metrics.live({ status: "connected", routes: [route(0, "live")] });
  // Minutes later a route resubscribes and a channel is joined.
  h.advance(300_000);
  h.metrics.live({
    status: "connected",
    routes: [route(0, "pending"), route(1, "pending")],
  });
  h.advance(30);
  h.metrics.live({
    status: "connected",
    routes: [route(0, "live"), route(1, "live")],
  });
  // A failed connection that is retried is a new phase.
  h.metrics.live({ status: "error", routes: [] });
  h.advance(5);
  h.metrics.live({ status: "connecting", routes: [] });
  const [open, retry] = h.metrics.summary().phases;
  expect(open).toMatchObject({
    coverageMs: 50,
    routes: 1,
    routeMs: { n: 1, max: 40 },
  });
  expect(retry).toMatchObject({ kind: "reconnect", start: 300_085 });
});

it("skips opens with nothing to paint, and keeps the shown channel across reset", () => {
  const h = setup();
  // An empty channel, then its first message arriving much later.
  h.metrics.channelIntent("empty", click(0));
  h.metrics.channelMounted("empty");
  h.metrics.channelEmpty("empty");
  h.advance(5000);
  h.metrics.channelRendered("empty", "verified");
  h.paint();
  // Rows that never become visible (a saved scroll position, say).
  h.metrics.channelIntent("scrolled", click(5000));
  h.metrics.channelMounted("scrolled");
  h.metrics.channelRendered("scrolled", "verified", () => false);
  for (let frame = 0; frame < 40; frame++) h.paint();
  expect(h.metrics.export().opens).toEqual([]);
  expect(h.metrics.summary().opens.skipped).toBe(2);
  h.metrics.reset();
  expect(h.metrics.summary().opens.skipped).toBe(0);
  h.metrics.channelIntent("scrolled", click(6000));
  h.metrics.channelRendered("scrolled", "verified");
  h.paint();
  expect(h.metrics.export().opens).toEqual([]);
});

it("ignores timer lag while the page is hidden", () => {
  vi.useFakeTimers();
  const listeners: (() => void)[] = [];
  const page = {
    hidden: false,
    addEventListener: (_: string, listener: () => void) =>
      listeners.push(listener),
  };
  vi.stubGlobal("document", page);
  try {
    let time = 0;
    const metrics = createClientMetrics({ now: () => time, monitor: true });
    metrics.cpu("fold", 1, 1); // Starts the monitor.
    page.hidden = true;
    for (const listener of listeners) listener();
    time += 1000; // Throttled to one tick a second.
    vi.advanceTimersByTime(50);
    time += 1000;
    vi.advanceTimersByTime(50);
    page.hidden = false;
    time += 400; // Visible again before the next tick.
    for (const listener of listeners) listener();
    time += 50;
    vi.advanceTimersByTime(50);
    expect(metrics.summary().mainThread.longTasks).toBe(0);
  } finally {
    vi.unstubAllGlobals();
  }
});

it("attributes long tasks and measured CPU to background work", () => {
  vi.useFakeTimers();
  let time = 0;
  const metrics = createClientMetrics({ now: () => time, monitor: true });
  const finished = metrics.background();
  metrics.cpu("verify.read", 12, 24);
  time += 250; // The loop was blocked; the 50 ms sampler fires late.
  vi.advanceTimersByTime(50);
  finished();
  time += 50;
  vi.advanceTimersByTime(50);
  time += 150;
  vi.advanceTimersByTime(50);
  metrics.cpu("verify.read", 3, 6);
  const { mainThread } = metrics.summary();
  expect(mainThread.longTasks).toBe(2);
  expect(mainThread.longTaskMs).toBe(200 + 100);
  expect(mainThread.backgroundLongTaskMs).toBe(200);
  expect(mainThread.cpu["verify.read"]).toEqual({
    ms: 15,
    count: 30,
    calls: 2,
    backgroundMs: 12,
  });
});

it("records nothing when disabled, and unit tests get the disabled singleton", () => {
  const h = setup({ enabled: false });
  h.metrics.channelMounted("alpha");
  h.metrics.channelRendered("alpha");
  h.metrics.query({ ms: 1, bytes: 1, priority: "foreground", ok: true });
  h.paint();
  expect(h.metrics.export()).toMatchObject({ opens: [], queries: [] });
  expect(clientMetrics.enabled).toBe(false);
});
