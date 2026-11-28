import { test, expect } from "./playwright-test.mjs";
import { createServer } from "./vite-server.mjs";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { anchor, expectAnchor, settle, wheel } from "./timeline.mjs";

const history = (page) =>
  page.getByRole("region", { name: "Channel message history" });

// Every mounted row's height and the scroller's offset: a card that changes
// size moves one of them, whether Virtua corrects for it or not.
const geometry = (page) =>
  history(page).evaluate((element) => ({
    scrollTop: element.scrollTop,
    rows: Object.fromEntries(
      [...element.querySelectorAll("[data-message-id]")].map((row) => [
        row.dataset.messageId,
        row.getBoundingClientRect().height,
      ]),
    ),
  }));

async function expectSteady(page, before, reader) {
  await expectAnchor(page, reader);
  const after = await geometry(page);
  expect(after.scrollTop, "no scroll correction").toBe(before.scrollTop);
  for (const [id, height] of Object.entries(after.rows))
    if (id in before.rows)
      expect(height, `row ${id} keeps its height`).toBe(before.rows[id]);
}

// No read is under way, and none starts while the timeline sits still.
async function expectIdle(page) {
  await expect(async () => {
    const sent = await page.evaluate(
      () => window.linkPreviewScroll.asked.length,
    );
    await settle(page);
    expect(
      await page.evaluate(() => [
        window.linkPreviewScroll.inFlight(),
        window.linkPreviewScroll.asked.length,
      ]),
    ).toEqual([0, sent]);
  }).toPass();
}

// Reads stay held while the reader moves; once they are let through, every
// card on screen fills in without moving anything.
async function releaseAndHold(page) {
  const before = await geometry(page);
  const reader = await anchor(page);
  await page.evaluate(() => window.linkPreviewScroll.release());
  await expect(
    history(page).locator("[data-link-previews] a[aria-busy]"),
  ).toHaveCount(0);
  await expect(
    history(page).locator("[data-link-previews] img").first(),
  ).toBeVisible();
  await expectIdle(page);
  await expectSteady(page, before, reader);
  await page.evaluate(() => window.linkPreviewScroll.hold());
}

test("link previews never move the reader in the real timeline", async ({
  page,
}) => {
  const server = await createServer({
    root: fileURLToPath(new URL("../../", import.meta.url)),
    configFile: false,
    envFile: false,
    plugins: [react()],
    logLevel: "error",
    server: { host: "127.0.0.1", port: 0 },
  });
  await server.listen();
  try {
    await page.goto(
      `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/link-preview-scroll.html`,
    );
    const feed = history(page);
    await expect(feed.locator("[data-message-id]").first()).toBeVisible();
    await feed.hover();
    await settle(page);

    // Mid-history, with every read held: cards draw at their final size.
    for (let i = 0; i < 4; i++) await wheel(page, -900);
    const pending = feed.locator("[data-link-previews] a[aria-busy]");
    expect(await pending.count()).toBeGreaterThan(0);
    await releaseAndHold(page);

    // A fling through unread history: cards scrolled past are withdrawn, so
    // every page or image read goes out for a card that is still mounted, and
    // while the host holds one, the rest wait where they can be withdrawn.
    const sent = await page.evaluate(
      () => window.linkPreviewScroll.dispatched.length,
    );
    const start = await feed.evaluate((element) => element.scrollTop);
    // Loaded WebKit runners coalesce some of a burst's wheel events, so keep
    // flinging until it has covered several screens.
    await expect(async () => {
      for (let i = 0; i < 10; i++) await page.mouse.wheel(0, -400);
      expect(
        start - (await feed.evaluate((element) => element.scrollTop)),
      ).toBeGreaterThan(3000);
    }).toPass({ intervals: [0] });
    await settle(page);
    const held = await page.evaluate(
      (sent) => window.linkPreviewScroll.dispatched.length - sent,
      sent,
    );
    expect(held).toBeLessThanOrEqual(1);
    await releaseAndHold(page);
    const fling = await page.evaluate(
      (sent) => window.linkPreviewScroll.dispatched.slice(sent),
      sent,
    );
    // Story n's page is on site{n} or more{n}, and its image on img{n}.
    const story = (url) => new URL(url).hostname.match(/\d+/)?.[0];
    const shown = (
      await feed
        .locator("[data-link-previews] a")
        .evaluateAll((cards) => cards.map((card) => card.href))
    ).map(story);
    expect(fling.some(({ url }) => url.includes("://img"))).toBe(true);
    expect(fling.filter(({ mounted }) => !mounted)).toEqual([]);
    // Once the host lets reads through, the reader isn't moving, so every
    // read after the one it held is for a card that is still on screen.
    expect(
      fling.slice(held).filter(({ url }) => !shown.includes(story(url))),
    ).toEqual([]);

    // Away and back: remounted cards draw from the cache on their first frame.
    const reader = await anchor(page);
    await wheel(page, 2500);
    await wheel(page, -2500);
    await settle(page);
    expect(await pending.count()).toBe(0);
    await page.evaluate(() => window.linkPreviewScroll.release());
    await settle(page);
    await page.evaluate(() => window.linkPreviewScroll.hold());
    expect((await anchor(page)).id).toBe(reader.id);

    // Older history lands above the reader while its reads are held.
    while ((await feed.evaluate((element) => element.scrollTop)) > 4)
      await wheel(page, -3000);
    await page.evaluate(() => window.linkPreviewScroll.loadOlder());
    await settle(page);
    await releaseAndHold(page);

    // Turned off and on again: a new loader with an empty cache.
    await page.evaluate(() => window.linkPreviewScroll.enable(false));
    await expect(feed.locator("[data-link-previews]")).toHaveCount(0);
    await page.evaluate(() => window.linkPreviewScroll.enable(true));
    await expect(pending.first()).toBeVisible();
    await settle(page);
    // And again while the last loader's read is still under way, so the two
    // loaders' reads overlap.
    await page.evaluate(() => window.linkPreviewScroll.enable(false));
    await page.evaluate(() => window.linkPreviewScroll.enable(true));
    await expect(pending.first()).toBeVisible();
    await settle(page);
    await releaseAndHold(page);
  } finally {
    await server.close();
  }
});
