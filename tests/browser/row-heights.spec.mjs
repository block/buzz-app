import { writeFile } from "node:fs/promises";
import { test, expect } from "./source-fixture.mjs";
import { watchPageErrors } from "./page-errors.mjs";
import { settle, virtuaIdle, wheel } from "./timeline.mjs";

// Browser-only: predicted row heights must equal each engine's own layout of
// the real ChannelTimeline (fonts, line breaking, 1/64px layout units, the
// bundled links and emoji plugins), and a seeded row must cost Virtua no
// correction. No DOM emulator lays out text. tests/fixtures/row-heights.tsx;
// counts come from DEV client metrics, whose sampling only observes. The
// dynamics case turns them off, as production is.

const widths = [480, 588.33, 613.37, 768, 1100];
const scales = [0.9, 1, 1.1, 1.3];
// No byline fits beside the widest time label here: every timeline row
// without another reason is left to measurement.
const narrow = { width: 320, scale: 1, narrow: true };
// Chromium fits a line up to a layout unit wider than this integer text
// column: four prose rows (twice) sit on that edge, as do the long tokens.
const edge = { width: 464, scale: 1, breaks: 20 };
const cells = [
  ...scales.flatMap((scale) =>
    widths.map((width) => ({ width, scale, narrow: false })),
  ),
  narrow,
  edge,
];
// WKWebView's default user agent has no Safari/ token (Pretext sniffs it).
const tauri =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)";
const history = (page) =>
  page.getByRole("region", { name: "Channel message history" });
async function attach(testInfo, name, value) {
  const path = testInfo.outputPath(name);
  await writeFile(path, JSON.stringify(value, null, 2));
  await testInfo.attach(name, { path, contentType: "application/json" });
}
// Custom emoji and attachment media: served, except the failing emoji and
// the video, audio and file bodies.
const media =
  '<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22"><circle cx="11" cy="11" r="10" fill="purple"/></svg>';
const served = (page) =>
  page.route(/^https:\/\/(?:media|emoji)\.test\//, (route) => {
    const url = route.request().url();
    return /missing|(?:video|audio|file)-\d+/.test(url)
      ? route.fulfill({ status: 404, body: "missing" })
      : route.fulfill({ contentType: "image/svg+xml", body: media });
  });
// Virtua measures a mounted row one frame after it mounts; wait two.
const frames = (page) =>
  page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
const rowHeights = (page) =>
  page.evaluate(() => window.__buzzClientMetrics.summary().rowHeights);
const counted = (summary) =>
  Object.values(summary).reduce(
    (sum, kind) =>
      sum +
      kind.predicted +
      Object.values(kind.unpredicted).reduce((a, b) => a + b, 0),
    0,
  );
const reasons = (summary) => {
  const all = {};
  for (const entry of Object.values(summary))
    for (const [reason, count] of Object.entries(entry.unpredicted))
      all[reason] = (all[reason] ?? 0) + count;
  return all;
};
// Every corpus row is sampled (the fixture is taller than the corpus); rows
// past the creation's seeding may be sampled more than once.
async function sampled(page, label) {
  const rows = await page.evaluate(async () => {
    await new Promise((resolve) => {
      const wait = () =>
        window.__rowHeights ? resolve() : requestAnimationFrame(wait);
      wait();
    });
    return window.__rowHeights.rows;
  });
  let summary = {};
  await expect
    .poll(
      async () => {
        summary = await rowHeights(page);
        return counted(summary) >= rows;
      },
      { message: `every row is sampled at ${label}` },
    )
    .toBe(true);
  return { rows, summary };
}
// The model's outcome for every row with the timeline's inputs (the
// fixture's), beside its height: every prediction must equal it.
async function outcomes(page, label) {
  const [list, kinds] = await page.evaluate(async () => [
    await window.__rowHeights.outcomes(),
    window.__rowHeights.kinds,
  ]);
  const wrong = list.filter(
    ({ outcome, height }) => typeof outcome === "number" && outcome !== height,
  );
  expect(wrong, `per-row predictions at ${label}`).toEqual([]);
  return list.map((entry) => ({ ...entry, kinds: kinds[entry.id] ?? [] }));
}
// Every predicted row is exact; with `seeded`, every one was also the size
// Virtua was seeded with (the creation seeds at most 100 rows).
function expectExact(summary, label, seeded = true) {
  let predicted = 0;
  for (const [kind, entry] of Object.entries(summary)) {
    expect(entry.mismatched, `${kind} at ${label}`).toBe(0);
    expect(entry.exact).toBe(entry.predicted);
    if (seeded)
      expect(entry.seeded, `${kind} seeded at ${label}`).toBe(entry.predicted);
    predicted += entry.predicted;
  }
  return predicted;
}
// Reasons that depend on the cell: knife edges, words wider than a line,
// bylines that do not fit, and link chips whose width could change the line
// count (anywhere between none and the chip's cap).
const dependent = ["edge", "wrap", "byline", "link-width"];
// The static corpus's deliberate exceptions, and nothing else: a reaction,
// and twice each (timeline and continuation) CJK punctuation beside Latin
// text and curly quotes beside Han, kerning across Pretext's pieces, one word
// in two text nodes of one font, nested strong and code, an en dash,
// unverified punctuation in a word, opening quotes after a word in another
// script, a punctuated number in right-to-left text, an emoji glued to a
// word, and small kana; with macOS fonts in Chromium, which kerns kana, the
// two other kana rows.
const fixed = {
  reactions: 1,
  "cjk-punctuation": 4,
  shaping: 2,
  glue: 2,
  "nested-strong": 2,
  markdown: 2,
  characters: 2,
  punctuation: 2,
  scripts: 2,
  bidi: 2,
  emoji: 2,
};
const corpora = {
  // Prose in every script and style the model claims, and its exceptions.
  static: ({ rows, summary }, label, engine, cell, _list, extra = {}) => {
    const predicted = expectExact(summary, label);
    const all = reasons(summary);
    const declined = Object.fromEntries(
      Object.entries(all).filter(([reason]) => !dependent.includes(reason)),
    );
    // Elsewhere fonts may differ: assert there only when no kana is kerned.
    const kana = engine === "chromium" && process.platform === "darwin" ? 6 : 2;
    if (process.platform === "darwin" || declined.kana === 2)
      expect(declined, `unpredicted at ${label}`).toEqual({
        ...fixed,
        kana,
        ...extra,
      });
    // The one link row, then the rows on knife edges or bylines.
    expect(all["link-width"] ?? 0).toBeLessThanOrEqual(1);
    const breaks = ["edge", "wrap", "byline"].reduce(
      (sum, reason) => sum + (all[reason] ?? 0),
      0,
    );
    if (cell.narrow)
      expect(all.byline, `bylines at ${label}`).toBeGreaterThan(20);
    else
      expect(breaks, `break-dependent at ${label}`).toBeLessThanOrEqual(
        cell.breaks ?? 10,
      );
    const left = Object.values(all).reduce((a, b) => a + b, 0);
    expect(predicted).toBe(rows - left);
  },
  // Mentions, links, channel references and custom emoji: atomic boxes that
  // never grow a line. Rows without a chip are always predicted where every
  // byline fits; a chip row where its width cannot change the line count.
  // Rows of kind `declined:<reason>` (content that would lay out unlike the
  // model) always have that reason.
  inline: ({ summary }, label, _engine, cell, list) => {
    const predicted = expectExact(summary, label);
    const declined = list.flatMap(({ kinds, outcome }) =>
      kinds
        .filter((kind) => kind.startsWith("declined:"))
        .map((kind) => [kind.slice("declined:".length), outcome]),
    );
    expect(
      declined.filter(([reason, outcome]) => outcome !== reason),
      `declined rows at ${label}`,
    ).toEqual([]);
    expect(
      Object.keys(reasons(summary))
        .filter((reason) => !dependent.includes(reason))
        .sort(),
      `unpredicted at ${label}`,
    ).toEqual([...new Set(declined.map(([reason]) => reason))].sort());
    expect(
      list.filter(({ outcome }) => typeof outcome === "number").length,
    ).toBe(predicted);
    if (cell.width >= 768) {
      const boxed = list.filter(
        ({ kinds }) =>
          !kinds.some(
            (kind) => kind === "chip" || kind.startsWith("declined:"),
          ),
      );
      expect(
        boxed.filter(({ outcome }) => typeof outcome !== "number"),
        `rows without a chip at ${label}`,
      ).toEqual([]);
    }
    if (cell.width === 1100 && cell.scale === 1)
      expect(
        list.filter(
          ({ kinds, outcome }) =>
            kinds.includes("chip") && typeof outcome === "number",
        ).length,
        `chip rows at ${label}`,
      ).toBeGreaterThan(0);
  },
  // The live mix of row kinds: membership, threads, reactions, attachments
  // and Markdown blocks stay measured; nothing predicted is wrong.
  complex: ({ summary }, label, _engine, cell, list) => {
    expectExact(summary, label, false);
    if (!cell.narrow)
      expect(
        list.filter(({ outcome }) => typeof outcome === "number").length,
        `predicted rows at ${label}`,
      ).toBeGreaterThan(0);
  },
};
/** Rows, predicted rows and reasons per kind of row (complex and inline). */
function coverage(list) {
  const kinds = {};
  for (const { kinds: names, outcome } of list)
    for (const name of names.length ? names : ["row"]) {
      kinds[name] ??= { rows: 0, predicted: 0, reasons: {} };
      const entry = kinds[name];
      entry.rows++;
      if (typeof outcome === "number") entry.predicted++;
      else entry.reasons[outcome] = (entry.reasons[outcome] ?? 0) + 1;
    }
  return kinds;
}

async function exactness(page, testInfo, engine, corpus) {
  const errors = watchPageErrors(page);
  await served(page);
  const report = [];
  const height = corpus === "complex" ? 60000 : 20000;
  for (const cell of cells) {
    const { width, scale } = cell;
    const label = `${corpus} ${width}px ×${scale}`;
    await page.goto(
      `/tests/fixtures/row-heights.html?corpus=${corpus}&width=${width}&scale=${scale}&height=${height}`,
    );
    const result = await sampled(page, label);
    const list = await outcomes(page, label);
    corpora[corpus](result, label, engine, cell, list);
    report.push({
      width,
      scale,
      ...result,
      ...(corpus === "static" ? {} : { coverage: coverage(list) }),
    });
  }
  await attach(testInfo, `row-heights-${corpus}.json`, report);
  expect(errors.unexplained()).toEqual([]);
}

for (const corpus of Object.keys(corpora)) {
  test(`predicted heights equal layout for every predicted row kind across widths and text scales (${corpus})`, async ({
    page,
    browserName,
  }, testInfo) => {
    test.setTimeout(300_000);
    await exactness(page, testInfo, browserName, corpus);
  });

  test.describe("with a Tauri-style user agent", () => {
    test.use({ userAgent: tauri });
    test(`predicted heights equal WebKit layout without a Safari/ token (${corpus})`, async ({
      page,
      browserName,
    }, testInfo) => {
      test.skip(browserName !== "webkit", "a WKWebView user agent");
      test.setTimeout(300_000);
      await exactness(page, testInfo, browserName, corpus);
    });
  });
}

test("rows needing a loading Inter subset wait for it, then predict exactly", async ({
  page,
  browserName,
}) => {
  const errors = watchPageErrors(page);
  let release = () => {};
  const held = new Promise((resolve) => {
    release = resolve;
  });
  await page.route(
    (url) => url.pathname.endsWith("/inter-cyrillic-wght-normal.woff2"),
    async (route) => {
      await held;
      await route.continue();
    },
  );
  const url =
    "/tests/fixtures/row-heights.html?corpus=static&width=768&height=20000&hold=cyrillic";
  await page.goto(url);
  try {
    // The Russian row (twice) waits; Pretext never measures fallback widths.
    corpora.static(
      await sampled(page, "a held subset"),
      "a held subset",
      browserName,
      { width: 768 },
      [],
      { font: 2 },
    );
  } finally {
    release();
  }
  await page.evaluate(() =>
    document.fonts.load('400 14px "Inter Variable"', "Привет"),
  );
  // A switch away and back once the subset loaded predicts those rows too.
  await page.evaluate(() => {
    window.__buzzClientMetrics.reset();
    window.__rowHeights.remount(768);
  });
  corpora.static(
    await sampled(page, "a loaded subset"),
    "a loaded subset",
    browserName,
    { width: 768 },
  );
  expect(errors.unexplained()).toEqual([]);
});

// Every scroller write and `ol` height after `start()`. A write during wheel
// traversal is a correction; an `ol` height change without a row count change
// is a size correction (tests/browser docs: Row heights).
async function instrument(page) {
  await page.addInitScript(() => {
    const list = () => document.querySelector("[data-message-scroller] > ol");
    const probe = {
      writes: [],
      heights: [],
      recording: false,
      // The committed height and row count when recording starts.
      start() {
        probe.writes.length = 0;
        probe.heights.length = 0;
        probe.rows = window.__rowHeights?.window();
        probe.last = { height: list()?.style.height, rows: probe.rows };
        probe.recording = true;
      },
    };
    window.__corrections = probe;
    for (const method of ["scrollBy", "scrollTo"]) {
      const original = Element.prototype[method];
      Element.prototype[method] = function (...args) {
        if (probe.recording && this.matches?.("[data-message-scroller]"))
          probe.writes.push({ method, args: JSON.stringify(args) });
        return original.apply(this, args);
      };
    }
    new MutationObserver(() => {
      const element = list();
      if (!element || !probe.recording) return;
      const record = {
        height: element.style.height,
        rows: window.__rowHeights?.window(),
      };
      if (record.height !== probe.last?.height) probe.heights.push(record);
      probe.last = record;
    }).observe(document, {
      subtree: true,
      attributes: true,
      attributeFilter: ["style"],
    });
  });
}
const start = (page) => page.evaluate(() => window.__corrections.start());
// After Virtua's idle and measurement barrier: no write or height can still
// land.
async function corrections(page) {
  await virtuaIdle(page);
  await frames(page);
  await settle(page);
  return page.evaluate(() => {
    const probe = window.__corrections;
    probe.recording = false;
    let rows = probe.rows;
    const unexplained = probe.heights.filter((record) => {
      const changed = record.rows !== rows;
      rows = record.rows;
      return !changed;
    });
    return { writes: probe.writes, unexplained, heights: probe.heights };
  });
}
// A wheel step, through Virtua's scroll end (which prepares mounted rows).
async function step(page, deltaY) {
  await wheel(page, deltaY);
  await virtuaIdle(page);
}
// The list's height changed since `start()`: an older page went in.
const inserted = (page) =>
  expect
    .poll(() => page.evaluate(() => window.__corrections.heights.length))
    .toBeGreaterThan(0);
// Reads up to the held older page and releases it. With `cpu`, the page's
// insert, predictions included, runs that many times slower (Chromium's CDP
// throttling).
async function olderPage(page, cpu = 1) {
  await history(page).hover();
  for (let steps = 0; ; steps++) {
    if (await page.evaluate(() => window.__rowHeights.pending)) break;
    expect(steps, "older history loads near the top").toBeLessThan(20);
    await step(page, -3000);
  }
  await start(page);
  const cdp = cpu > 1 ? await page.context().newCDPSession(page) : undefined;
  await cdp?.send("Emulation.setCPUThrottlingRate", { rate: cpu });
  try {
    await page.evaluate(() => window.__rowHeights.release());
    await inserted(page);
    await frames(page);
  } finally {
    await cdp?.send("Emulation.setCPUThrottlingRate", { rate: 1 });
    await cdp?.detach();
  }
  await settle(page);
  return corrections(page);
}

// Production builds record no client metrics, so the DEV sampler never runs
// and cannot have prepared a row the traversal later needs.
async function withoutClientMetrics(page) {
  await page.route(
    (url) => url.pathname.endsWith("/src/features/developer/client-metrics.ts"),
    async (route) => {
      const response = await route.fetch();
      const body = (await response.text()).replace(
        "enabled: import.meta.env?.DEV === true",
        "enabled: false",
      );
      await route.fulfill({ response, body });
    },
  );
}

test("an older page and a warm remount traverse without size corrections", async ({
  page,
  browserName,
}, testInfo) => {
  const errors = watchPageErrors(page);
  await withoutClientMetrics(page);
  await instrument(page);
  await page.goto("/tests/fixtures/row-heights.html?corpus=paging&width=900");
  const feed = history(page);
  await feed.waitFor();
  expect(
    await page.evaluate(() => "__buzzClientMetrics" in window),
    "client metrics are off, as in production",
  ).toBe(false);
  await settle(page);
  const evidence = [];
  // The shift's jump is a page's only write: its rows and the former first
  // row need no correction. In Chromium the first page goes in on a 6x
  // slower CPU: its insert still predicts the whole page.
  for (let round = 0; round < 2; round++) {
    const slow = round === 0 && browserName === "chromium";
    const prepend = await olderPage(page, slow ? 6 : 1);
    evidence.push({ prepend: round, ...prepend });
    expect(prepend.writes, "only the shift's own jump").toHaveLength(1);
    expect(prepend.unexplained).toEqual([]);
  }
  // A switch away and back at another width: no geometry snapshot applies,
  // so every row Virtua mounts during traversal comes from a prediction:
  // seeded by a page, or prepared after Virtua measured it (the fill at
  // settle and scroll end; without it this fails in both engines).
  await page.evaluate(() => window.__rowHeights.remount(860));
  await settle(page);
  const rows = await page.evaluate(() => window.__rowHeights.window());
  await start(page);
  await feed.hover();
  // Up to the top, then down to the bottom. Steps stay below the 1,600px
  // buffer, so adjacent mounted ranges overlap; rows mount on both sides.
  const seen = new Set();
  let steps = 0;
  for (const direction of [-1, 1]) {
    for (let step = 0; step < 100; step++, steps++) {
      for (const id of await feed
        .locator("[data-message-id]")
        .evaluateAll((items) => items.map((item) => item.dataset.messageId)))
        seen.add(id);
      const remaining = await feed.evaluate(
        (element, direction) =>
          direction < 0
            ? element.scrollTop
            : element.scrollHeight - element.clientHeight - element.scrollTop,
        direction,
      );
      if (remaining < 4) break;
      await wheel(page, direction * 1400);
    }
  }
  const traversal = await corrections(page);
  evidence.push({ traversal: { rows, steps, seen: seen.size }, ...traversal });
  await attach(testInfo, "corrections.json", evidence);
  expect(seen.size, "the traversal crosses every retained row").toBe(rows);
  expect(traversal.writes, "no corrective writes").toEqual([]);
  expect(traversal.heights, "no size corrections").toEqual([]);
  expect(errors.unexplained()).toEqual([]);
});

// Rows wholly outside the viewport: none without Virtua's buffer.
const outside = (feed) =>
  feed.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const items = Array.from(element.querySelectorAll("[data-message-id]"));
    return {
      above: items.filter(
        (item) => item.getBoundingClientRect().bottom < box.top,
      ).length,
      below: items.filter(
        (item) => item.getBoundingClientRect().top > box.bottom,
      ).length,
    };
  });

test("a new timeline mounts its buffer once idle or at the reader's first input", async ({
  page,
}) => {
  const errors = watchPageErrors(page);
  // Idle periods arrive only when the test runs them.
  await page.addInitScript(() => {
    window.__idle = [];
    window.requestIdleCallback = (callback) => window.__idle.push(callback);
    window.cancelIdleCallback = () => {};
  });
  await page.goto("/tests/fixtures/row-heights.html?corpus=paging&width=900");
  const feed = history(page);
  await feed.waitFor();
  await settle(page);
  // Positioned and painted, with no idle period yet: only the viewport.
  await expect
    .poll(() => page.evaluate(() => window.__idle.length))
    .toBeGreaterThan(0);
  expect(await outside(feed)).toEqual({ above: 0, below: 0 });
  await page.evaluate(() => {
    for (const run of window.__idle.splice(0))
      run({ didTimeout: false, timeRemaining: () => 50 });
  });
  await expect.poll(async () => (await outside(feed)).above).toBeGreaterThan(0);
  // A new Virtualizer (a switch back): the first wheel mounts it at once.
  await page.evaluate(() => window.__rowHeights.remount(860));
  await settle(page);
  expect(await outside(feed)).toEqual({ above: 0, below: 0 });
  await feed.hover();
  await page.mouse.wheel(0, -200);
  await expect.poll(async () => (await outside(feed)).above).toBeGreaterThan(0);
  expect(errors.unexplained()).toEqual([]);
});

// WebKit has no idle callbacks. A task right after the next frame lands in
// the frame after a switch's first visible one, so the buffer waits until
// the timeline has had no new rows, size or scroll for a moment (the unit test of
// after-next-frame-idle.ts owns that clock), or for the first input. Every
// engine runs this path here, without requestIdleCallback.
test("without idle callbacks, the buffer waits for a quiet timeline or the reader's first input", async ({
  page,
}) => {
  const errors = watchPageErrors(page);
  await page.addInitScript(() => {
    window.requestIdleCallback = undefined;
  });
  // First the quiet moment never comes; the response is not cached.
  const quiet = (url) =>
    url.pathname.endsWith("/src/features/messages/after-next-frame-idle.ts");
  let held = false;
  await page.route(quiet, async (route) => {
    const response = await route.fetch();
    const source = await response.text();
    const body = source.replace("QUIET_MS = 100", "QUIET_MS = 1e9");
    held = body !== source;
    await route.fulfill({
      response,
      body,
      headers: { ...response.headers(), "cache-control": "no-store" },
    });
  });
  await page.goto("/tests/fixtures/row-heights.html?corpus=paging&width=900");
  const feed = history(page);
  await feed.waitFor();
  await settle(page);
  expect(held, "the quiet period is held").toBe(true);
  expect(await outside(feed)).toEqual({ above: 0, below: 0 });
  await feed.hover();
  await page.mouse.wheel(0, -200);
  await expect.poll(async () => (await outside(feed)).above).toBeGreaterThan(0);
  // Then, with no input, the buffer follows the quiet moment by itself.
  await page.unroute(quiet);
  await page.reload();
  await feed.waitFor();
  await expect.poll(async () => (await outside(feed)).above).toBeGreaterThan(0);
  expect(errors.unexplained()).toEqual([]);
});

test("an inline target reveal mounts the buffer around its row", async ({
  page,
}) => {
  const errors = watchPageErrors(page);
  await page.goto(
    "/tests/fixtures/row-heights.html?corpus=paging&width=900&target=20",
  );
  const feed = history(page);
  await expect
    .poll(() =>
      page.evaluate(
        () => !!document.activeElement?.closest("[data-message-id]"),
      ),
    )
    .toBe(true);
  await virtuaIdle(page);
  await frames(page);
  await settle(page);
  const mounted = await outside(feed);
  expect(mounted.above, "rows mounted above the viewport").toBeGreaterThan(0);
  expect(mounted.below, "rows mounted below the viewport").toBeGreaterThan(0);
  expect(errors.unexplained()).toEqual([]);
});

// Messages arriving a page per commit are each predicted whole, and seeded
// measurements never complete Virtua's own estimate: a seeded Virtualizer's
// buffer must not wait for it, an empty window must be seeded too, and a
// short one opened before the model was ready (whose buffer waits) must stay
// unseeded.
test("a timeline opened empty, or short before the model is ready, mounts the buffer as messages arrive", async ({
  context,
}) => {
  for (const [name, initial, lazy] of [
    ["empty", 0, false],
    ["short, Pretext loading", 3, true],
  ]) {
    const page = await context.newPage();
    const errors = watchPageErrors(page);
    let release = () => {};
    const held = new Promise((resolve) => {
      release = resolve;
    });
    if (lazy)
      await page.route(
        (url) => url.pathname.includes("pretext"),
        async (route) => {
          await held;
          await route.continue();
        },
      );
    const feed = history(page);
    try {
      await page.goto(
        `/tests/fixtures/row-heights.html?corpus=arrivals&initial=${initial}&width=900${lazy ? "&pretext=lazy" : ""}`,
        { waitUntil: "commit" },
      );
      await feed.waitFor();
      await expect(feed.locator("[data-message-id]")).toHaveCount(initial);
      await settle(page);
    } finally {
      release();
    }
    await page.evaluate(() => window.__rowHeights.ready());
    await frames(page);
    for (let batch = 0; batch < 3; batch++) {
      await page.evaluate(() => window.__rowHeights.append(20));
      await frames(page);
    }
    await settle(page);
    // Up into the middle, where rows lie on both sides.
    await feed.hover();
    for (let steps = 0; ; steps++) {
      const { top, middle } = await feed.evaluate((element) => ({
        top: element.scrollTop,
        middle: (element.scrollHeight - element.clientHeight) / 2,
      }));
      if (top <= middle) break;
      expect(steps, `${name}: reading up`).toBeLessThan(10);
      await step(page, -1200);
    }
    const mounted = await outside(feed);
    expect(mounted.above, `${name}: rows mounted above`).toBeGreaterThan(0);
    expect(mounted.below, `${name}: rows mounted below`).toBeGreaterThan(0);
    expect(errors.unexplained()).toEqual([]);
    await page.close();
  }
});

// The model is not ready when a Virtualizer is created: Pretext still
// loading (a cold launch), or no hover (a touch device). It must keep
// Virtua's own estimate, exactly as without canvas text measurement (and
// stays unseeded once the model is ready: see the arrivals case).
const opened = async (page, url) => {
  // WebKit's load event waits for the held Pretext import.
  await page.goto(url, { waitUntil: "commit" });
  await history(page).waitFor();
  await settle(page);
  await frames(page);
  await settle(page);
  return history(page).evaluate((element) => ({
    list: element.querySelector(":scope > ol")?.style.height,
    top: element.scrollTop,
    mounted: Array.from(
      element.querySelectorAll("[data-message-id]"),
      (item) => item.dataset.messageId,
    ),
  }));
};
const noCanvas = () => {
  delete window.OffscreenCanvas;
};
const noHover = () => {
  const original = window.matchMedia.bind(window);
  window.matchMedia = (query) => {
    const list = original(query);
    if (!query.includes("hover")) return list;
    return new Proxy(list, {
      get: (target, key) => {
        if (key === "matches") return false;
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  };
};

test("a Virtualizer created before the model is ready keeps Virtua's own sizing", async ({
  context,
}) => {
  const url = "/tests/fixtures/row-heights.html?corpus=paging&width=900";
  const lazy = `${url}&pretext=lazy`;
  for (const [name, setup, reference] of [
    ["no hover", [noHover], [noHover, noCanvas]],
    ["Pretext loading", [], [noCanvas]],
  ]) {
    const stock = await context.newPage();
    for (const script of reference) await stock.addInitScript(script);
    const expected = await opened(stock, lazy);
    await stock.close();

    const page = await context.newPage();
    const errors = watchPageErrors(page);
    for (const script of setup) await page.addInitScript(script);
    let release = () => {};
    const held = new Promise((resolve) => {
      release = resolve;
    });
    if (name === "Pretext loading")
      await page.route(
        (url) => url.pathname.includes("pretext"),
        async (route) => {
          await held;
          await route.continue();
        },
      );
    try {
      expect(await opened(page, lazy), name).toEqual(expected);
    } finally {
      release();
    }
    expect(errors.unexplained()).toEqual([]);
    await page.close();
  }
});

test("a text-scale change in a hidden pane recalibrates when the pane shows", async ({
  page,
}) => {
  const errors = watchPageErrors(page);
  // Chromium reports this to the window only; WebKit's page error is allowed.
  await page.addInitScript(() => {
    window.__observerLoops = 0;
    addEventListener("error", (event) => {
      if (event.message?.startsWith("ResizeObserver loop"))
        window.__observerLoops++;
    });
  });
  await page.goto("/tests/fixtures/row-heights.html?corpus=paging&width=900");
  await history(page).waitFor();
  await settle(page);
  const probe = page.locator("[data-probe]");
  await page.evaluate(() => window.__rowHeights.hide(true));
  await expect(page.locator("[data-message-scroller] > ol")).toHaveCount(0);
  await page.evaluate(() =>
    document.documentElement.style.setProperty("--buzz-text-scale", "1.1"),
  );
  // The epoch's calibration rows mount, but a hidden probe has no size.
  await expect(probe).not.toHaveCount(0);
  await frames(page);
  await expect(probe).not.toHaveCount(0);
  await page.evaluate(() => {
    window.__buzzClientMetrics.reset();
    window.__rowHeights.hide(false);
  });
  await expect(probe).toHaveCount(0);
  await settle(page);
  await frames(page);
  await settle(page);
  // Showing reset the scroller's offset; the reader still follows the bottom.
  expect(
    await history(page).evaluate(
      (element) =>
        element.scrollHeight - element.clientHeight - element.scrollTop,
    ),
    "distance from the bottom",
  ).toBeLessThanOrEqual(1);
  // The Virtualizer created on show was seeded at the new scale. A scroll end
  // samples every mounted row, the buffer the ramp mounted included.
  await history(page).hover();
  await step(page, -200);
  const mounted = await history(page).locator("[data-message-id]").count();
  let summary = {};
  await expect
    .poll(async () => {
      summary = await rowHeights(page);
      return counted(summary);
    })
    .toBeGreaterThanOrEqual(mounted);
  const seeded = Object.values(summary).reduce(
    (sum, { seeded }) => sum + seeded,
    0,
  );
  expect(seeded).toBeGreaterThan(0);
  for (const [kind, entry] of Object.entries(summary))
    expect(entry.mismatched, kind).toBe(0);
  expect(reasons(summary)).not.toHaveProperty("uncalibrated");
  // Calibrating from the resize, the rows mount after the observer delivered.
  expect(await page.evaluate(() => window.__observerLoops)).toBe(0);
  expect(errors.unexplained()).toEqual([]);
});
