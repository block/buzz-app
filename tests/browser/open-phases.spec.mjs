import { writeFile } from "node:fs/promises";
import { test, expect } from "./fixture.mjs";
import { settle } from "./timeline.mjs";
import { holdReadingFocus, markAllRead } from "./reading.mjs";

// Where one channel open spends its time, by source, from the app's own open
// timings (Settings → Developer → Client performance). A diagnostic, run only
// with BUZZ_OPEN_PHASES=1; see "Open steps" in docs/performance.md. It asserts
// that each open was timed to the paint that shows its screen, never a
// duration.

test.skip(!process.env.BUZZ_OPEN_PHASES, "Diagnostic: set BUZZ_OPEN_PHASES=1");
const LATENCY_MS = Number(process.env.BUZZ_OPEN_LATENCY_MS ?? 0);
const UNREAD = 4;

test.use({
  productionBroker: true,
  readState: true,
  membershipActivity: true,
  clientMetrics: true,
  // BUZZ_OPEN_DEV_REACT=1: development React, as `just desktop` runs.
  developmentReact: process.env.BUZZ_OPEN_DEV_REACT === "1",
  historyCounts: { alpha: 60, beta: 5 },
  // BUZZ_OPEN_NOTICES=500: that many join notices, newer than Alpha's history.
  membershipBurst: Number(process.env.BUZZ_OPEN_NOTICES ?? 0),
  // BUZZ_OPEN_NAMED=1: each joiner has a profile.
  membershipBurstNamed: process.env.BUZZ_OPEN_NAMED === "1",
  viewport: { width: 1280, height: 800 },
});

const history = (page) =>
  page.getByRole("region", { name: "Channel message history" });
const sidebarRow = (page, name) =>
  page.getByRole("button", { name: new RegExp(`^${name}`) });
const composer = (page, name) =>
  page.getByRole("textbox", { name: `Message #${name}`, exact: true });

/** The first painted frame with Alpha's rows in the DOM, the first that
 * shows them, and the last that changed what they show (`final`), with how
 * many shown frames changed it (`changes`), from `window.openFrames.t0`. */
function frames() {
  const state = {
    t0: 0,
    rows: null,
    shown: null,
    final: null,
    changes: 0,
    last: "",
  };
  window.openFrames = state;
  /** What the shown rows say and where, as a reader sees them. */
  const visible = (feed) => {
    const viewport = feed.getBoundingClientRect();
    return [...feed.querySelectorAll("[data-message-id]")]
      .map((row) => [row, row.getBoundingClientRect()])
      .filter(
        ([, box]) => box.bottom > viewport.top && box.top < viewport.bottom,
      )
      .map(
        ([row, box]) =>
          `${Math.round(box.top - viewport.top)}:${row.innerText.replace(/\s+/g, " ")}`,
      )
      .join("|");
  };
  const sample = () => {
    const feed = document.querySelector(
      '[data-channel-timeline="alpha"]:has([data-message-id])',
    );
    if (!feed) return;
    const t = performance.now() - state.t0;
    state.rows ??= t;
    if (getComputedStyle(feed).opacity === "0") return;
    state.shown ??= t;
    const seen = visible(feed);
    if (seen === state.last) return;
    if (state.last) state.changes++;
    state.last = seen;
    state.final = t;
  };
  const painted = new MessageChannel();
  painted.port1.onmessage = sample;
  const tick = () => {
    painted.port2.postMessage(null);
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

/** Alpha has unread rows, so its open decides a New messages line. */
async function seed(page, app) {
  await holdReadingFocus(page);
  await page.addInitScript(frames);
  await page.addInitScript(() => {
    // Hover preparation is off until a path turns it on.
    window.fixtureSaveData = true;
    Object.defineProperty(Navigator.prototype, "connection", {
      configurable: true,
      get: () => ({ saveData: window.fixtureSaveData }),
    });
  });
  app.relay.latency(LATENCY_MS);
  await page.goto(
    `${app.origin}/#buzz=${encodeURIComponent(
      JSON.stringify({
        version: 1,
        kind: "conversation",
        channelId: "beta",
        scope: {
          viewer: app.viewer,
          communityOrigin: "https://primary.example",
        },
      }),
    )}`,
  );
  await onBeta(page);
  await markAllRead(page);
  const now = Math.floor(Date.now() / 1000) + 1;
  for (let i = 0; i < UNREAD; i++)
    app.append(
      "primary",
      "alpha",
      `Unread follow-up ${i}`,
      true,
      false,
      undefined,
      undefined,
      [],
      now + i,
    );
  await expect(
    sidebarRow(page, "Alpha").locator("[data-channel-unread]"),
  ).toHaveCount(1);
}

async function onBeta(page) {
  await expect(composer(page, "Beta")).toBeVisible();
  await expect(
    history(page).locator("[data-message-id]").first(),
  ).toBeVisible();
  await settle(page);
}

async function clickOpen(page) {
  await page.evaluate(() => {
    window.__buzzClientMetrics.reset();
    Object.assign(window.openFrames, {
      rows: null,
      shown: null,
      final: null,
      changes: 0,
      last: "",
    });
    document.addEventListener(
      "click",
      (event) => {
        window.openFrames.t0 = event.timeStamp;
        window.openStarted();
      },
      { capture: true, once: true },
    );
  });
  await sidebarRow(page, "Alpha").click();
}
async function visitAlpha(page) {
  await sidebarRow(page, "Alpha").click();
  await expect(composer(page, "Alpha")).toBeVisible();
  await settle(page);
  await sidebarRow(page, "Beta").click();
  await onBeta(page);
}

const paths = {
  // Never read this session, nothing saved: the open waits for the relay.
  async network(page) {
    await page.reload();
    await onBeta(page);
    await clickOpen(page);
  },
  // A pointer rests on the row 150 ms before the click; the hover starts the read.
  async hover(page) {
    await page.reload();
    await onBeta(page);
    await page.evaluate(() => {
      window.fixtureSaveData = false;
    });
    await sidebarRow(page, "Alpha").hover();
    await page.evaluate(
      () => new Promise((resolve) => setTimeout(resolve, 150)),
    );
    await clickOpen(page);
  },
  // Never read this session, clicked once startup has settled: the live
  // route is up and the roster verified, as most opens in a running app are.
  async steady(page) {
    await page.reload();
    await onBeta(page);
    await page.evaluate(
      (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      STEADY_MS,
    );
    await clickOpen(page);
  },
  // The same, with the pointer resting on the row 150 ms before the click.
  async "steady-hover"(page) {
    await page.reload();
    await onBeta(page);
    await page.evaluate(
      (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      STEADY_MS,
    );
    await page.evaluate(() => {
      window.fixtureSaveData = false;
    });
    await sidebarRow(page, "Alpha").hover();
    await page.evaluate(
      () => new Promise((resolve) => setTimeout(resolve, 150)),
    );
    await clickOpen(page);
  },
  // Read earlier this session.
  async memory(page) {
    await visitAlpha(page);
    await clickOpen(page);
  },
  // Saved by an earlier session, clicked after a reload.
  async disk(page) {
    await visitAlpha(page);
    await page.reload();
    await onBeta(page);
    await clickOpen(page);
  },
  // Reopened by the reload itself, from the saved head: timed from the pane mount.
  async reload(page) {
    await sidebarRow(page, "Alpha").click();
    await expect(composer(page, "Alpha")).toBeVisible();
    await settle(page);
    await page.reload();
  },
};

// Long enough for startup's live routes, catch-ups and roster to settle.
const STEADY_MS = 3_000;
const repeats = Number(process.env.BUZZ_OPEN_REPEATS ?? 3);
for (const path of Object.keys(paths))
  for (let i = 1; i <= repeats; i++)
    test(`${path} open phases, ${LATENCY_MS} ms relay, sample ${i}`, async ({
      page,
      app,
    }, testInfo) => {
      await seed(page, app);
      // Every read from the open's start, for finding what a step waited on.
      const reads = [];
      let since;
      page.on("request", (request) => {
        if (since === undefined || !request.url().endsWith("/query")) return;
        const read = {
          t: Date.now() - since,
          priority: request.headers()["x-buzz-read-priority"],
          filters: (request.postDataJSON() ?? []).map((filter) => ({
            kinds: filter.kinds,
            h: filter["#h"]?.length,
            authors: filter.authors?.length,
            limit: filter.limit,
          })),
        };
        reads.push(read);
        request
          .response()
          .then(() => {
            read.done = Date.now() - since;
          })
          .catch(() => {});
      });
      await page.exposeFunction("openStarted", () => {
        since = Date.now();
        reads.length = 0;
      });
      await paths[path](page);
      await expect(composer(page, "Alpha")).toBeVisible();
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              window.__buzzClientMetrics
                .export()
                .opens.filter((open) => open.channel === "alpha").length,
          ),
        )
        .toBe(1);
      // Late names, lines and rows change the screen after it shows.
      await page.evaluate(
        () => new Promise((resolve) => setTimeout(resolve, 2_000)),
      );
      const result = await page.evaluate(() => ({
        open: window.__buzzClientMetrics
          .export()
          .opens.find((open) => open.channel === "alpha"),
        frames: { ...window.openFrames, last: undefined },
        // The whole client-metrics export, with its open trace.
        metrics: window.__buzzClientMetrics.export(),
      }));
      const report = testInfo.outputPath("open-phases.json");
      await writeFile(
        report,
        JSON.stringify(
          { path, latencyMs: LATENCY_MS, ...result, reads },
          null,
          1,
        ),
      );
      await testInfo.attach("open-phases.json", {
        path: report,
        contentType: "application/json",
      });
      // The open ends at the paint that shows the screen, not the hidden one.
      expect(result.open.steps.shown).toBeDefined();
      expect(result.open.ms).toBeGreaterThanOrEqual(result.open.steps.shown);
    });
