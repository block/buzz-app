import { setTimeout as hold } from "node:timers/promises";
import { test, expect, repeats, timeline } from "./runner.mjs";

const others = Array.from(
  { length: 30 },
  (_, i) => `c${String(i).padStart(2, "0")}`,
);
const IDLE_MS = 8_000;
const TRAFFIC_MS = 30_000;
const INTERVAL_MS = 200;
const DRAIN_MS = 2_000;
const SETTLE_MS = 5_000;
const durations = {
  scriptMs: "ScriptDuration",
  layoutMs: "LayoutDuration",
  styleMs: "RecalcStyleDuration",
  taskMs: "TaskDuration",
};
const gauges = {
  heapBytes: "JSHeapUsedSize",
  nodes: "Nodes",
  listeners: "JSEventListeners",
};

// Fixed windows are the measurement, not synchronization: the page runs
// freely while Node holds each one.
// Peers post into channels the viewer is not reading. Nothing on screen
// needs to change, so the work per message is the cost of staying current.
for (const [name, options] of [
  ["background-traffic", {}],
  ["background-traffic-large-sidebar", { largeSidebar: true }],
])
  test.describe(name, () => {
    test.use({
      channelIds: ["alpha", "beta", ...others],
      historyCounts: { alpha: 40, beta: 1 },
      ...options,
    });
    for (let i = 1; i <= repeats; i++)
      test(`${name} sample ${i}`, async ({ app, page, perf }) => {
        test.setTimeout(180_000);
        const { cdp } = perf;
        const read = async () => {
          const { metrics } = await cdp.send("Performance.getMetrics");
          const value = (name) => {
            const found = metrics.find((m) => m.name === name)?.value;
            if (!Number.isFinite(found))
              throw new Error(`Missing browser counter ${name}`);
            return found;
          };
          return {
            ...Object.fromEntries(
              Object.entries(durations).map(([k, n]) => [k, value(n) * 1000]),
            ),
            ...Object.fromEntries(
              Object.entries(gauges).map(([k, n]) => [k, value(n)]),
            ),
          };
        };
        const collected = async () => {
          await cdp.send("HeapProfiler.collectGarbage");
          return read();
        };
        const spent = (from, to) =>
          Object.fromEntries(
            Object.keys(durations).map((k) => [k, to[k] - from[k]]),
          );

        await perf.setup("alpha");
        await hold(SETTLE_MS);
        const startHeap = await collected();
        const sent = [];
        let idle, traffic, trafficWallMs;
        try {
          await cdp.send("Emulation.setCPUThrottlingRate", {
            rate: Number(process.env.PERF_CPU),
          });
          const idleStart = await read();
          await hold(IDLE_MS);
          idle = spent(idleStart, await read());

          const trafficStart = await read();
          const began = Date.now();
          while (Date.now() - began < TRAFFIC_MS) {
            const channel = others[sent.length % others.length];
            sent.push({
              channel,
              event: app.append(
                "primary",
                channel,
                `Agent update ${sent.length}: build passed, 3 files changed`,
                true,
                false,
              ),
            });
            await hold(INTERVAL_MS);
          }
          trafficWallMs = Date.now() - began;
          await hold(DRAIN_MS);
          traffic = spent(trafficStart, await read());
        } finally {
          await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
        }
        const endHeap = await collected();

        const last = sent.at(-1);
        await perf.open(last.channel);
        await expect(
          page.locator(
            `${timeline(last.channel)} [data-message-id="${last.event.id}"]`,
          ),
          "the last background message reached the client",
        ).toBeVisible();

        const windowMs = trafficWallMs + DRAIN_MS;
        // Gross, not idle-subtracted: a late startup task in the idle window
        // would otherwise make background traffic look cheaper.
        const perMessage = (key) => traffic[key] / sent.length;
        const sample = {
          state: app.report.state,
          work: {
            messages: sent.length,
            channels: others.length,
            idleMs: IDLE_MS,
            trafficWallMs,
            drainMs: DRAIN_MS,
            intervalMs: INTERVAL_MS,
            largeSidebar: !!options.largeSidebar,
          },
          metrics: {
            idleTaskMsPerSec: (idle.taskMs / IDLE_MS) * 1000,
            trafficTaskMsPerSec: (traffic.taskMs / windowMs) * 1000,
            taskMsPerMessage: perMessage("taskMs"),
            scriptMsPerMessage: perMessage("scriptMs"),
            styleMsPerMessage: perMessage("styleMs"),
            layoutMsPerMessage: perMessage("layoutMs"),
            heapGrowthKBPerMessage:
              (endHeap.heapBytes - startHeap.heapBytes) / 1024 / sent.length,
            nodesDelta: endHeap.nodes - startHeap.nodes,
            listenersDelta: endHeap.listeners - startHeap.listeners,
          },
        };
        app.report.measurements.push(sample);
        await perf.save(sample);
        expect(sent.length).toBeGreaterThan(100);
      });
  });
