import { settle } from "./timeline.mjs";
import { test, expect } from "./fixture.mjs";
// A long transcript exercises virtual scrolling; browser frames verify that
// provisional reply UI neither resizes history nor displaces its reading anchor.
test.use({
  productionBroker: true,
  readState: true,
  historyCounts: { alpha: 30 },
});
test("reply preview keeps transcript in place", async ({
  page,
  app,
}, testInfo) => {
  await page.goto(app.origin);
  await page
    .getByRole("navigation", { name: "Apps", exact: true })
    .getByRole("button", { name: "Alpha", exact: true })
    .first()
    .click();
  const editor = page.getByRole("textbox", {
    name: "Message #Alpha",
    exact: true,
  });
  await expect(editor).toBeVisible();
  const message = page
    .locator("[data-channel-timeline] [data-message-id]")
    .filter({ hasText: "primary alpha message 28" })
    .last()
    .locator("p")
    .first();
  await expect(message).toBeVisible();
  await settle(page);
  const history = page.locator("[data-channel-timeline]");
  const originalHeight = await history.evaluate((el) => el.clientHeight);
  const samples = await message.evaluateHandle((el) => {
    const values = [];
    let frame;
    const sample = () => {
      const s = el.closest("[data-message-scroller]");
      values.push({
        y: el.getBoundingClientRect().y,
        scroll: s.scrollTop,
        height: s.clientHeight,
      });
      frame = requestAnimationFrame(sample);
    };
    sample();
    return {
      stop() {
        cancelAnimationFrame(frame);
        return values;
      },
    };
  });
  await message.hover();
  await page.mouse.down();
  await expect(
    page.getByRole("button", { name: "Cancel reply target" }),
  ).toBeVisible();
  expect(await history.evaluate((el) => el.clientHeight)).toBe(originalHeight);
  await page.screenshot({ path: testInfo.outputPath("reply-preview.png") });
  const point = await message.boundingBox();
  await page.mouse.move(point.x + 10, point.y + 10);
  await page.mouse.up();
  await expect(
    page.getByRole("button", { name: "Cancel reply target" }),
  ).toHaveCount(0);
  await settle(page);
  const frames = await samples.evaluate((s) => s.stop());
  await testInfo.attach("positions", {
    body: JSON.stringify(frames),
    contentType: "application/json",
  });
  expect(
    Math.max(...frames.map((f) => f.y)) - Math.min(...frames.map((f) => f.y)),
  ).toBeLessThan(2);
  await page.setViewportSize({ width: 480, height: 950 });
  await page.emulateMedia({ colorScheme: "dark" });
  await message.scrollIntoViewIfNeeded();
  await settle(page);
  const narrowHeight = await history.evaluate((el) => el.clientHeight);
  await editor.fill("Keep my reply draft");
  await message.hover();
  await page.mouse.down();
  const cancel = page.getByRole("button", { name: "Cancel reply target" });
  await expect(cancel).toBeInViewport();
  await page.mouse.up();
  await expect(page.getByRole("textbox")).toHaveText("Keep my reply draft");
  expect(await history.evaluate((el) => el.clientHeight)).toBe(narrowHeight);
  await page.screenshot({
    path: testInfo.outputPath("reply-preview-narrow.png"),
  });
  await cancel.click();
  await expect(cancel).toHaveCount(0);
  await expect(editor).toHaveText("Keep my reply draft");
});
