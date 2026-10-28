import { test, expect } from "./source-fixture.mjs";

// Native playback, CSS animation completion and the first exposed rendering
// update cannot be established by jsdom. This is correctness, not a perf case.
test("covered native playback stays live and restores current controls across pane moves and close", async ({
  page,
}) => {
  await page.goto("/tests/fixtures/workspace-publication.html");
  const video = page.locator("video");
  const original = await video.elementHandle();
  const progress = page.locator('input[aria-label="Video progress"]');
  await expect
    .poll(() => video.evaluate((v) => v.readyState))
    .toBeGreaterThanOrEqual(2);
  await video.evaluate((v) => {
    v.muted = true;
    v.loop = true;
  });
  await page.locator("[data-video-preview]").hover();
  await page.getByRole("button", { name: "Play video", exact: true }).click();
  await expect
    .poll(() => video.evaluate((v) => !v.paused && v.currentTime > 0))
    .toBe(true);
  await page.getByRole("tab", { name: "Other", exact: true }).click();
  await expect
    .poll(() =>
      video.evaluate((v) => !!v.closest("[data-covered]:not([data-leaving])")),
    )
    .toBe(true);
  const held = await progress.inputValue();
  const before = await video.evaluate((v) => v.currentTime);
  await expect
    .poll(() => video.evaluate((v) => v.currentTime))
    .not.toBe(before);
  expect(await video.evaluate((v) => v.paused)).toBe(false);
  await expect(progress).toHaveValue(held);
  // Native seek is fixture setup for the source-sensitive restoration oracle.
  await video.evaluate(
    (v) =>
      new Promise((resolve) => {
        v.addEventListener("seeked", resolve, { once: true });
        v.currentTime = Math.min(1.25, v.duration / 2);
      }),
  );
  await expect(progress).toHaveValue(held);
  await page.getByRole("tab", { name: "Player", exact: true }).click();
  const first = await video.evaluate(
    (v) =>
      new Promise((resolve) =>
        requestAnimationFrame(() => {
          const input = v
            .closest("[data-video-preview]")
            .querySelector('input[aria-label="Video progress"]');
          resolve({
            actual: v.currentTime,
            published: Number(input.value),
            paused: v.paused,
          });
        }),
      ),
  );
  expect(first.paused).toBe(false);
  // The native range is quantized to its declared 0.1 second step.
  expect(Math.abs(first.actual - first.published)).toBeLessThan(0.2);
  await page.getByRole("button", { name: "Move player", exact: true }).click();
  expect(await original.evaluate((v) => v.isConnected)).toBe(true);
  await expect(
    page.getByRole("region", { name: "Side pane" }).locator("video"),
  ).toHaveCount(1);
  await page.getByRole("button", { name: "Move player", exact: true }).click();
  await expect(page.locator("[data-panel-dock]")).toHaveCount(0);
  expect(await video.evaluate((v, old) => v === old, original)).toBe(true);
  expect(await video.evaluate((v) => v.paused)).toBe(false);
  for (const theme of ["light", "dark"]) {
    await page.evaluate((theme) => {
      document.documentElement.classList.toggle("dark", theme === "dark");
      document.documentElement.dataset.colorMode = theme;
    }, theme);
    for (const width of [1200, 480]) {
      await page.setViewportSize({ width, height: 800 });
      await page.evaluate(() => {
        document.documentElement.style.fontSize = "20px";
      });
      await expect(progress).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Pause video", exact: true }),
      ).toBeEnabled();
    }
  }
  await page.getByRole("button", { name: "Close player", exact: true }).click();
  await expect(video).toHaveCount(0);
  expect(await original.evaluate((v) => v.isConnected)).toBe(false);
});
