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
  await settle(page);
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
    // apart from the reads already under way when it began, every read that
    // goes out is for a card still on screen.
    const sent = await page.evaluate(
      () => window.linkPreviewScroll.asked.length,
    );
    const start = await feed.evaluate((element) => element.scrollTop);
    for (let i = 0; i < 30; i++) await page.mouse.wheel(0, -400);
    await settle(page);
    expect(
      start - (await feed.evaluate((element) => element.scrollTop)),
    ).toBeGreaterThan(3000);
    await releaseAndHold(page);
    const fling = await page.evaluate(
      (sent) => window.linkPreviewScroll.asked.slice(sent),
      sent,
    );
    const shown = await feed
      .locator("[data-link-previews] a")
      .evaluateAll((cards) => cards.map((card) => card.href));
    expect(fling.slice(4).filter((url) => !shown.includes(url))).toEqual([]);

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
    await releaseAndHold(page);
  } finally {
    await server.close();
  }
});
