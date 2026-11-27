import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test, expect } from "../playwright-test.mjs";
import { previewFixtures } from "../vite-server.mjs";
import { loafBlocking } from "./blocking.mjs";

// A pull request's Changes tab: the real GitHub panel and diff viewer on a
// fixture page, over a scripted `gh` that answers block/buzz-app#3984's diff
// after 500ms (tests/fixtures/github-pull-changes.tsx). Each sample loads the
// page fresh, so `-open` also loads the grammars.
const fixturePage = "tests/fixtures/github-pull-changes.html";
const repeats = Number(process.env.PERF_REPEAT ?? 1);
// The files the viewer highlights on main. The two Markdown files have no
// grammar, and members.ts and members.test.ts are past its size limit, so
// those four stay plain text.
const plain = new Set([
  "docs/plugin-authoring-guide.md",
  "docs/plugins.md",
  "src/features/channel-members/members.ts",
  "src/features/channel-members/members.test.ts",
]);

const expected = [
  ...readFileSync(
    new URL("../../fixtures/github-pull-changes.diff", import.meta.url),
    "utf8",
  ).matchAll(/^diff --git a\/\S+ b\/(\S+)$/gm),
]
  .map((match) => match[1])
  .filter((name) => !plain.has(name));

let fixtures;
test.beforeAll(async () => {
  fixtures = await previewFixtures([fixturePage], { production: true });
});
test.afterAll(() => fixtures?.close());

// One observer per operation. Every animation frame it reads the panel:
// - firstContentMs: a file's diff, plain or highlighted, is on screen.
// - highlightedMs: every file on screen that can be highlighted is.
// - allHighlightedMs: every such file in the diff is, wherever it is; absent
//   when some never are, as with a viewer that draws only what is near view.
// - durationMs: the panel's last change, once nothing changed for 500ms.
function watch({ expected, timeoutMs }) {
  const panel = document.querySelector('aside[aria-label="GitHub"]');
  const wanted = new Set(expected);
  const lit = new WeakSet();
  const frames = [];
  const longAnimationFrames = [];
  const times = {};
  let start, lastChange, previous, raf, timer, resolve, observer;
  const result = new Promise((r) => {
    resolve = r;
  });
  const isLit = (section) => {
    const container = section.querySelector("diffs-container");
    if (!container) return false;
    if (lit.has(container)) return true;
    const found = !!container.shadowRoot?.querySelector(
      '[style*="--diffs-token"]',
    );
    if (found) lit.add(container);
    return found;
  };
  // A file's name: its section's label, or a raw diff's first header line.
  const nameOf = (element) =>
    element.matches("section[aria-label]")
      ? element.getAttribute("aria-label")
      : /^diff --git a\/\S+ b\/(\S+)/.exec(element.textContent ?? "")?.[1];
  function stop(error) {
    cancelAnimationFrame(raf);
    clearTimeout(timer);
    const end = performance.now() - start;
    // Let the last frame's entry arrive before reading them.
    requestAnimationFrame(() =>
      requestAnimationFrame(() =>
        setTimeout(() => {
          observer.takeRecords().forEach(collect);
          observer.disconnect();
          resolve({
            error,
            ...times,
            durationMs: lastChange,
            frames: frames.length,
            longAnimationFrames: longAnimationFrames.filter(
              (entry) => entry.startMs < end,
            ),
            endMs: end,
          });
        }, 0),
      ),
    );
  }
  function collect(entry) {
    longAnimationFrames.push({
      startMs: entry.startTime - start,
      durationMs: entry.duration,
      blockingDurationMs: entry.blockingDuration,
    });
  }
  function sample() {
    const now = performance.now() - start;
    frames.push(now);
    const box = panel.getBoundingClientRect();
    const files = [
      ...panel.querySelectorAll(
        'section[aria-label], pre[aria-label="Raw diff"]',
      ),
    ].filter(
      (element) => wanted.has(nameOf(element)) || element.matches("pre"),
    );
    const inView = files.filter((element) => {
      const r = element.getBoundingClientRect();
      return r.height > 0 && r.bottom > box.top && r.top < box.bottom;
    });
    const litNames = new Set(
      files
        .filter((element) => element.matches("section") && isLit(element))
        .map(nameOf),
    );
    if (inView.length) times.firstContentMs ??= now;
    if (
      inView.length &&
      inView.every(
        (element) =>
          !wanted.has(nameOf(element)) ||
          (element.matches("section") && isLit(element)),
      )
    )
      times.highlightedMs ??= now;
    if (expected.every((name) => litNames.has(name)))
      times.allHighlightedMs ??= now;
    const signature = JSON.stringify([
      panel.scrollHeight,
      files.length,
      litNames.size,
      inView.length,
    ]);
    if (signature !== previous) lastChange = now;
    previous = signature;
    if (times.highlightedMs !== undefined && now - lastChange >= 500)
      return stop();
    raf = requestAnimationFrame(sample);
  }
  return {
    start() {
      start = performance.now();
      lastChange = 0;
      observer = new PerformanceObserver((list) =>
        list.getEntries().forEach(collect),
      );
      observer.observe({ type: "long-animation-frame", buffered: false });
      timer = setTimeout(
        () => stop(`Changes did not highlight within ${timeoutMs}ms`),
        timeoutMs,
      );
      raf = requestAnimationFrame(sample);
    },
    result: () => result,
  };
}

const counters = {
  scriptMs: "ScriptDuration",
  layoutMs: "LayoutDuration",
  styleMs: "RecalcStyleDuration",
  taskMs: "TaskDuration",
};

// The largest Chromium renderer under this test's browser: the page's, with
// its workers. A closed test's renderer can linger, but holds less. Worker heaps are not readable over CDP, so this is where a
// worker's memory shows.
function rendererRssMB() {
  const rows = execFileSync("ps", ["-axo", "pid=,ppid=,rss=,command="], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
    .split("\n")
    .map((line) => /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line))
    .filter(Boolean)
    .map(([, pid, ppid, rss, command]) => ({ pid, ppid, rss: +rss, command }));
  const parent = new Map(rows.map((row) => [row.pid, row.ppid]));
  // This worker launched the browser; other Chromiums may be running.
  const underBrowser = (pid) => {
    for (let at = parent.get(pid); at && at !== "0"; at = parent.get(at))
      if (at === String(process.pid)) return true;
    return false;
  };
  const renderers = rows.filter(
    (row) => row.command.includes("--type=renderer") && underBrowser(row.pid),
  );
  if (!renderers.length) throw new Error("No Chromium renderer found");
  return Math.max(...renderers.map((row) => row.rss)) / 1024;
}

async function measure(page, cdp, act) {
  const read = async () => {
    const { metrics } = await cdp.send("Performance.getMetrics");
    return Object.fromEntries(
      Object.entries(counters).map(([key, name]) => [
        key,
        metrics.find((m) => m.name === name).value * 1000,
      ]),
    );
  };
  const readsBefore = await page.evaluate(() => window.pullChanges.diffReads);
  await cdp.send("Emulation.setCPUThrottlingRate", {
    rate: Number(process.env.PERF_CPU ?? 1),
  });
  const watcher = await page.evaluateHandle(watch, {
    expected,
    timeoutMs: 30_000,
  });
  try {
    const before = await read();
    await watcher.evaluate((w) => w.start());
    await act();
    const recording = await watcher.evaluate((w) => w.result());
    const after = await read();
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
    expect(recording.error).toBeUndefined();
    const metrics = {};
    for (const key of Object.keys(after))
      metrics[key] = after[key] - before[key];
    for (const key of [
      "firstContentMs",
      "highlightedMs",
      "allHighlightedMs",
      "durationMs",
    ])
      if (recording[key] !== undefined) metrics[key] = recording[key];
    metrics.loafBlockingMs = loafBlocking({
      longAnimationFrames: recording.longAnimationFrames,
      durationMs: recording.endMs,
    });
    // What stays once the work is done, after a full collection.
    await cdp.send("HeapProfiler.collectGarbage");
    metrics.jsHeapMB =
      (await cdp.send("Runtime.getHeapUsage")).usedSize / 2 ** 20;
    metrics.domNodes = (await cdp.send("Memory.getDOMCounters")).nodes;
    metrics.rendererRssMB = rendererRssMB();
    return {
      work: {
        diffReads:
          (await page.evaluate(() => window.pullChanges.diffReads)) -
          readsBefore,
        frames: recording.frames,
      },
      metrics,
      recording,
    };
  } finally {
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
    await watcher.dispose();
  }
}

async function setup(page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");
  await cdp.send("HeapProfiler.enable");
  await page.goto(`${fixtures.origin}/${fixturePage}`);
  await page.evaluate(async () => {
    await Promise.all([...document.fonts].map((font) => font.load()));
  });
  const tab = page.getByRole("tab", { name: /^Changes/ });
  await expect(tab).toBeVisible();
  return { cdp, tab };
}

// A click through the browser's input, so its handlers count as script.
async function click(cdp, locator) {
  const box = await locator.boundingBox();
  const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  for (const type of ["mousePressed", "mouseReleased"])
    await cdp.send("Input.dispatchMouseEvent", {
      type,
      ...point,
      button: "left",
      clickCount: 1,
    });
}

const save = (testInfo, sample) =>
  testInfo.attach("perf-sample", {
    body: JSON.stringify(sample),
    contentType: "application/json",
  });

// Summary to Changes, the first time: the diff, the grammars and every file.
test.describe("pull-changes-open", () => {
  for (let i = 1; i <= repeats; i++)
    test(`pull-changes-open sample ${i}`, async ({ page }, testInfo) => {
      const { cdp, tab } = await setup(page);
      const sample = await measure(page, cdp, () => click(cdp, tab));
      expect(sample.work.diffReads).toBe(1);
      await save(testInfo, sample);
    });
});

// The same pull request's panel closed and opened again: it opens on Changes,
// with the grammars loaded.
test.describe("pull-changes-reopen", () => {
  for (let i = 1; i <= repeats; i++)
    test(`pull-changes-reopen sample ${i}`, async ({ page }, testInfo) => {
      const { cdp, tab } = await setup(page);
      await measure(page, cdp, () => click(cdp, tab));
      await page.evaluate(() => window.pullChanges.close());
      await expect(tab).toBeHidden();
      const sample = await measure(page, cdp, () =>
        page.evaluate(() => window.pullChanges.open()),
      );
      await save(testInfo, sample);
    });
});
