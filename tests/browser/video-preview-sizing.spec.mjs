import { test, expect } from "./source-fixture.mjs";

// Browser layout is required: percentage widths inside an outgoing fit-content
// message can collapse even though the media has a valid aspect ratio.
test("video-only outgoing messages keep a readable, proportional preview", async ({
  page,
}) => {
  await page.goto("/tests/fixtures/message-gallery.html?group=attachments", {
    waitUntil: "domcontentloaded",
  });
  await expect(
    page.locator('[data-message-id="video"] [data-video-preview]'),
  ).toBeVisible();
  for (const theme of ["light", "dark"]) {
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 950 });
      for (const rem of [16, 20]) {
        await page.evaluate(
          ({ theme, rem }) => {
            document.documentElement.dataset.colorMode = theme;
            document.documentElement.style.fontSize = `${rem}px`;
            document.documentElement.style.setProperty(
              "--type-rem",
              `${rem}px`,
            );
          },
          { theme, rem },
        );
        for (const [id, ratio] of [
          ["video", 16 / 9],
          ["video-portrait", 9 / 16],
        ]) {
          const row = page.locator(`[data-message-id="${id}"]`);
          const preview = row.locator("[data-video-preview]");
          await expect
            .poll(async () => {
              const media = await preview.boundingBox();
              const body = await row
                .locator('[class*="messageBody"]')
                .boundingBox();
              // On narrow screens the avatar gutters and frame determine the
              // available width; on wide screens the minimum must stand alone.
              return (
                media.width >=
                Math.min(16 * rem, width === 1440 ? 16 * rem : body.width)
              );
            })
            .toBe(true);
          const media = await preview.boundingBox();
          expect(media.width / media.height).toBeCloseTo(ratio, 2);
          expect(media.x).toBeGreaterThanOrEqual(0);
          expect(media.x + media.width).toBeLessThanOrEqual(width);
        }
      }
    }
  }
});
