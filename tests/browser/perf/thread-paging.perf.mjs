import { test, expect, repeats, timeline } from "./runner.mjs";
import { scrollCadence, topEdgeWait } from "./cadence.mjs";
import {
  populateThread,
  THREAD_CHANNEL,
  THREAD_REPLIES,
} from "./thread-corpus.mjs";
import { hoverMessage } from "../message-actions.mjs";
import { readJournal } from "../reading.mjs";
import { settle } from "../timeline.mjs";

// Live older-page paging in a long thread: starts read on the newest 10 replies
// at the bottom and exercises ThreadPanel's scrollback prefetching under real
// wheel gestures and modeled relay delays.
const historySelector = '[aria-label="Thread messages"]';
const topLevel = ":scope > [data-thread-rows] > ol > li[data-layout]";
const INITIAL_WINDOW_SIZE = 10;
const PAGE_SIZE = 50;
const EXPECTED_OLDER_PAGES = Math.ceil(
  (THREAD_REPLIES - INITIAL_WINDOW_SIZE) / PAGE_SIZE,
);
const GESTURE_PX = 2500;
const FLING_SPEED_PX_PER_SEC = 12000;
const MID_READ_PRELOAD_PAGES = 6;
const MID_READ_SCROLL_TOP_PX = 4500;
// Upward is positive in Chromium's gesture distance; negative scrolls downward.
const MID_READ_MOVES = [
  [-1200, 3000],
  [-1200, 3000],
  [1200, 3000],
];

const isNested = (event) =>
  event.tags.some(([name, , , marker]) => name === "e" && marker === "root");
const history = (page) =>
  page.getByRole("region", { name: "Thread messages", exact: true });

// Open the 460-reply thread already marked read through its newest reply so
// it lands at the bottom on the initial 10-reply window with zero older reads.
async function openReadThread(page, app, perf) {
  const root = populateThread(app);
  const replies = app.inboxWindow.replies;
  const ids = [root.id, ...replies.map((event) => event.id)];
  const oldestReply = replies.find((event) => !isNested(event));
  const expectedTopLevel = THREAD_REPLIES - replies.filter(isNested).length;
  const latest = replies.at(-1);
  app.serveReadState({ [`thread:${root.id}`]: latest.created_at });
  await perf.setup(THREAD_CHANNEL);
  await expect
    .poll(
      () =>
        app.report.queries.some(
          ({ community, filter }) =>
            community === "primary" && filter?.read_state_snapshot === 1,
        ),
      { message: "read-state snapshot loaded" },
    )
    .toBe(true);
  await expect
    .poll(
      async () =>
        (await readJournal(page))?.state?.frontiers?.[`thread:${root.id}`] ?? 0,
      { message: "thread read frontier hydrated" },
    )
    .toBeGreaterThanOrEqual(latest.created_at);
  const row = page
    .locator(timeline(THREAD_CHANNEL))
    .locator(`[data-message-id="${root.id}"]`);
  await hoverMessage(row);
  const reply = page
    .locator('[role="group"][aria-label="Message actions"]:popover-open')
    .getByRole("button", { name: "Reply", exact: true });
  await expect(reply).toBeVisible();
  const readsBeforeOpen = app.pending.length;
  await reply.click();
  const element = history(page);
  await expect(element).not.toHaveAttribute("data-positioning");
  await expect(element.getByRole("alert")).toHaveCount(0);
  await settle(page, element);
  const initial = await element.evaluate((node) => ({
    topLevel: node.querySelectorAll(
      ":scope > [data-thread-rows] > ol > li[data-layout]",
    ).length,
    mountedRows: node.querySelectorAll("[data-message-id]").length,
    scrollTop: node.scrollTop,
    scrollHeight: node.scrollHeight,
    clientHeight: node.clientHeight,
  }));
  expect(
    app.pending.length - readsBeforeOpen,
    "read thread opens without requesting older pages",
  ).toBe(0);
  expect(initial.topLevel, "opens on initial page only").toBeLessThanOrEqual(
    INITIAL_WINDOW_SIZE,
  );
  expect(
    initial.scrollHeight - initial.clientHeight - initial.scrollTop,
    "opens at the latest reply",
  ).toBeLessThan(2);
  return { root, ids, oldestReply, expectedTopLevel, element, initial };
}

// Click the empty right gutter to establish pointer modality, then run a 1px
// downward warm-up gesture without triggering older-page loading.
async function preparePointer(page, cdp, element) {
  const box = await element.boundingBox();
  await page.mouse.click(box.x + box.width - 12, box.y + box.height / 2);
  const point = {
    x: Math.round(box.x + box.width / 2),
    y: Math.round(box.y + box.height / 2),
  };
  await page.mouse.move(point.x, point.y);
  expect(
    await page.evaluate(() =>
      document.documentElement.hasAttribute("data-keyboard-navigation"),
    ),
    "pointer modality",
  ).toBe(false);
  await cdp.send("Input.synthesizeScrollGesture", {
    ...point,
    xDistance: 0,
    yDistance: -1,
    speed: 1000,
    gestureSourceType: "mouse",
    preventFling: true,
  });
  await settle(page, element);
  return point;
}

for (const [name, olderPageDelayMs] of [
  ["thread-paging-fast", 100],
  ["thread-paging-delayed", 500],
])
  test.describe(name, () => {
    test.use({
      productionBroker: true,
      readState: true,
      inboxThreadWindow: true,
      olderPageDelayMs,
      channelIds: ["alpha", THREAD_CHANNEL],
      historyCounts: { alpha: 1, [THREAD_CHANNEL]: 0 },
    });
    for (let i = 1; i <= repeats; i++)
      test(`${name} sample ${i}`, async ({ page, app, perf }) => {
        test.setTimeout(180_000);
        const { ids, oldestReply, expectedTopLevel, element, initial } =
          await openReadThread(page, app, perf);
        const point = await preparePointer(page, perf.cdp, element);
        const olderReadsBefore = app.pending.length;
        expect(
          olderReadsBefore,
          "no older pages requested before scrolling",
        ).toBe(0);
        let gestures = 0;
        let reachedOldest = false;
        const sample = await perf.measure(THREAD_CHANNEL, {
          selector: historySelector,
          ids,
          timeoutMs: 120_000,
          work: {
            replies: THREAD_REPLIES,
            initialTopLevel: initial.topLevel,
            olderResponseDelayMs: olderPageDelayMs,
            requestedPxPerGesture: GESTURE_PX,
            speedPxPerSecond: FLING_SPEED_PX_PER_SEC,
          },
          act: async () => {
            while (!reachedOldest && gestures < 250) {
              await perf.cdp.send("Input.synthesizeScrollGesture", {
                ...point,
                xDistance: 0,
                yDistance: GESTURE_PX,
                speed: FLING_SPEED_PX_PER_SEC,
                gestureSourceType: "mouse",
                preventFling: true,
              });
              gestures++;
              reachedOldest = await element.evaluate((node, id) => {
                const row = node.querySelector(`[data-message-id="${id}"]`);
                if (!row) return false;
                const box = row.getBoundingClientRect();
                const viewport = node.getBoundingClientRect();
                return box.bottom > viewport.top && box.top < viewport.bottom;
              }, oldestReply.id);
            }
          },
        });
        const edge = topEdgeWait(sample.recording);
        const olderReceipts = app.pending.slice(olderReadsBefore);
        const olderReadsDuring = olderReceipts.length;
        const olderReleaseDelaysMs = olderReceipts.map(
          ({ releaseDelayMs }) => releaseDelayMs,
        );
        const received = new Set(
          olderReceipts
            .filter(({ releaseDelayMs }) => releaseDelayMs !== undefined)
            .flatMap(({ events }) => events.map(({ id }) => id)),
        );
        const topLevelReplies = await element.locator(topLevel).count();
        const mountedRows = await element.locator("[data-message-id]").count();
        Object.assign(sample.metrics, scrollCadence(sample.recording), {
          edgeWaitMs: edge.edgeWaitMs,
          edgeHits: edge.edgeHits,
          maxEdgeSpanMs: edge.maxEdgeSpanMs,
          olderReadsDuring,
        });
        Object.assign(sample.work, {
          gestures,
          wheels: sample.recording.wheels,
          olderReadsBefore,
          olderReadsDuring,
          olderReleaseDelaysMs,
          olderRowsReceived: received.size,
          edgeSpansMs: edge.edgeSpansMs,
          reachedOldest,
          oldestId: oldestReply.id,
          topLevelReplies,
          mountedRows,
        });
        await perf.save(sample);
        expect(reachedOldest, "input reaches the oldest reply").toBe(true);
        expect(sample.work.wheels, "real wheel input").toBeGreaterThan(0);
        expect(
          olderReadsDuring,
          "older pages loaded during upward paging",
        ).toBe(EXPECTED_OLDER_PAGES);
        for (const delay of olderReleaseDelaysMs)
          expect(
            delay,
            "modeled older-page delay took effect",
          ).toBeGreaterThanOrEqual(olderPageDelayMs - 10);
        expect(topLevelReplies, "all top-level replies loaded").toBe(
          expectedTopLevel,
        );
        expect(
          sample.recording.frames.at(-1).rows.map(([id]) => id),
          "oldest reply remains visible after settling",
        ).toContain(oldestReply.id);
        await expect(element.getByRole("alert")).toHaveCount(0);
      });
  });

test.describe("thread-paging-mid-read", () => {
  test.use({
    productionBroker: true,
    readState: true,
    inboxThreadWindow: true,
    olderPageDelayMs: 100,
    channelIds: ["alpha", THREAD_CHANNEL],
    historyCounts: { alpha: 1, [THREAD_CHANNEL]: 0 },
  });
  for (let i = 1; i <= repeats; i++)
    test(`thread-paging-mid-read sample ${i}`, async ({ page, app, perf }) => {
      test.setTimeout(180_000);
      const { ids, element } = await openReadThread(page, app, perf);
      // Preload 6 older pages (~310 replies) while leaving 3 pages on the
      // relay, releasing each preload page immediately so setup stays fast.
      // Preload before clicking/wheeling into the pane so olderDemand starts
      // false and is consumed by each preload wheel without carrying over.
      const box = await element.boundingBox();
      const point = {
        x: Math.round(box.x + box.width / 2),
        y: Math.round(box.y + box.height / 2),
      };
      await page.mouse.move(box.x + box.width - 12, box.y + box.height / 2);
      let released = app.pending.length;
      for (let pageIndex = 0; pageIndex < MID_READ_PRELOAD_PAGES; pageIndex++) {
        const before = await element.locator(topLevel).count();
        await element.evaluate((node) => {
          node.scrollTop = 0;
        });
        await page.mouse.wheel(0, -400);
        await expect
          .poll(() => app.pending.length, { message: "preload page requested" })
          .toBeGreaterThan(released);
        while (released < app.pending.length) app.pending[released++].release();
        await expect
          .poll(() => element.locator(topLevel).count(), {
            message: "preload page rendered",
          })
          .toBeGreaterThan(before);
      }
      await settle(page, element);
      await page.mouse.move(point.x, point.y);
      // Position the reader well below the top of loaded history. The last
      // preload consumed olderDemand, so setting scrollTop and focusing
      // programmatically does not trigger another read before the measured
      // reading gestures start.
      await element.evaluate((node, target) => {
        node.scrollTop = target;
        node.focus({ preventScroll: true });
      }, MID_READ_SCROLL_TOP_PX);
      await settle(page, element);
      expect(
        await page.evaluate(() =>
          document.documentElement.hasAttribute("data-keyboard-navigation"),
        ),
        "pointer modality",
      ).toBe(false);
      const preRead = await element.evaluate((node) => ({
        topLevel: node.querySelectorAll(
          ":scope > [data-thread-rows] > ol > li[data-layout]",
        ).length,
        mountedRows: node.querySelectorAll("[data-message-id]").length,
        scrollTop: node.scrollTop,
        scrollHeight: node.scrollHeight,
        clientHeight: node.clientHeight,
      }));
      const readsBefore = app.pending.length;
      expect(
        readsBefore,
        "preload loaded 6 older pages without extra reads",
      ).toBe(MID_READ_PRELOAD_PAGES);
      expect(
        preRead.topLevel,
        "preloaded ~310 replies before reading",
      ).toBeGreaterThanOrEqual(250);
      expect(
        preRead.scrollTop,
        "positioned well below the top of loaded history",
      ).toBeGreaterThanOrEqual(MID_READ_SCROLL_TOP_PX - 10);

      const sample = await perf.measure(THREAD_CHANNEL, {
        selector: historySelector,
        ids,
        timeoutMs: 60_000,
        work: {
          replies: THREAD_REPLIES,
          olderResponseDelayMs: 100,
          preloadedPages: MID_READ_PRELOAD_PAGES,
          preReadTopLevel: preRead.topLevel,
          preReadMountedRows: preRead.mountedRows,
          scrollTopBefore: preRead.scrollTop,
          scrollHeightBefore: preRead.scrollHeight,
          moves: MID_READ_MOVES,
        },
        act: async () => {
          for (const [yDistance, speed] of MID_READ_MOVES) {
            const readsBeforeMove = app.pending.length;
            const rowsBeforeMove = await element.locator(topLevel).count();
            await perf.cdp.send("Input.synthesizeScrollGesture", {
              ...point,
              xDistance: 0,
              yDistance,
              speed,
              gestureSourceType: "mouse",
              preventFling: true,
            });
            // If this scroll triggered an older page, let it land and render
            // inside the measurement window before the next reading scroll.
            if (app.pending.length > readsBeforeMove) {
              await expect
                .poll(
                  () =>
                    app.pending
                      .slice(readsBeforeMove)
                      .every(
                        ({ releaseDelayMs }) => releaseDelayMs !== undefined,
                      ),
                  { message: "triggered older page released" },
                )
                .toBe(true);
              await expect
                .poll(() => element.locator(topLevel).count(), {
                  message: "triggered older page rendered",
                })
                .toBeGreaterThan(rowsBeforeMove);
            }
          }
        },
      });
      const unwantedReceipts = app.pending.slice(readsBefore);
      await expect
        .poll(
          () =>
            unwantedReceipts.every(
              ({ releaseDelayMs }) => releaseDelayMs !== undefined,
            ),
          { message: "any triggered older reads finished releasing" },
        )
        .toBe(true);
      await settle(page, element);
      const postReadTopLevel = await element.locator(topLevel).count();
      const postReadMountedRows = await element
        .locator("[data-message-id]")
        .count();
      const tops = sample.recording.frames
        .map(({ top }) => top)
        .filter((top) => top !== null);
      const minScrollTopPx = Math.min(preRead.scrollTop, ...tops);
      const scrollTopRangePx =
        Math.max(preRead.scrollTop, ...tops) - minScrollTopPx;
      const unwantedOlderReads = unwantedReceipts.length;
      const extraRowsLoaded = postReadMountedRows - preRead.mountedRows;
      const olderReleaseDelaysMs = unwantedReceipts.map(
        ({ releaseDelayMs }) => releaseDelayMs,
      );
      Object.assign(sample.metrics, scrollCadence(sample.recording), {
        unwantedOlderReads,
        extraRowsLoaded,
        minScrollTopPx,
        scrollTopRangePx,
      });
      Object.assign(sample.work, {
        wheels: sample.recording.wheels,
        olderReadsBefore: readsBefore,
        unwantedOlderReads,
        extraRowsLoaded,
        postReadTopLevel,
        postReadMountedRows,
        olderReleaseDelaysMs,
      });
      await perf.save(sample);
      expect(sample.work.wheels, "real wheel input").toBeGreaterThan(0);
      expect(
        minScrollTopPx,
        "reader stayed well below the top of loaded history",
      ).toBeGreaterThan(2000);
      expect(
        scrollTopRangePx,
        "reader scrolled through mid-thread replies",
      ).toBeGreaterThan(1000);
      for (const delay of olderReleaseDelaysMs)
        expect(
          delay,
          "modeled older-page delay applied to triggered reads",
        ).toBeGreaterThanOrEqual(90);
      await expect(element.getByRole("alert")).toHaveCount(0);
    });
});
