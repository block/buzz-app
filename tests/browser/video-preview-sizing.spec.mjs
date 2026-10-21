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
    for (const width of [390, 1440]) {
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
              const bounds = await row.locator("[data-layout]").boundingBox();
              // The layout reserves at least 60% of the row for message content.
              // Measure that independent row, never the shrink-to-fit body.
              return (
                media.width >=
                Math.floor(Math.min(16 * rem, bounds.width * 0.6))
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

// Extreme metadata must not place playback controls screens below the preview.
// The same renderer also owns decoded images embedded in GitHub descriptions.
test("extreme video metadata stays bounded with reachable controls and uncropped content", async ({
  page,
}) => {
  await page.goto("/tests/fixtures/message-gallery.html?group=attachments", {
    waitUntil: "domcontentloaded",
  });
  const row = page.locator('[data-message-id="video-extreme"]');
  const preview = row.locator("[data-video-preview]");
  await expect(preview).toBeVisible();
  await expect
    .poll(async () => (await preview.boundingBox()).height)
    .toBeLessThanOrEqual(512);
  await expect
    .poll(async () => (await row.boundingBox()).height)
    .toBeLessThan(600);
  await expect(preview.locator("video")).toHaveCSS("object-fit", "contain");
  await expect(preview.locator("img")).toHaveCSS("object-fit", "contain");
  await preview.scrollIntoViewIfNeeded();
  await preview.hover();
  await expect(
    preview.getByRole("slider", { name: "Video progress" }),
  ).toBeInViewport();
  const fullscreen = preview.getByRole("button", {
    name: "Open video fullscreen",
  });
  await expect(fullscreen).toBeInViewport();
  await fullscreen.click();
  await expect(
    page.getByRole("dialog", { name: "Video attachment" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(fullscreen).toBeFocused();
});

// Exercise the real embedded-image caller, after decoding tall image dimensions.
test("tall GitHub body images stay bounded without cropping", async ({
  page,
}) => {
  await page.route(
    "https://user-images.githubusercontent.com/fixture/tall.png",
    (route) =>
      route.fulfill({
        contentType: "image/svg+xml",
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="6000"><rect width="1000" height="6000" fill="teal"/><circle cx="500" cy="500" r="400" fill="gold"/></svg>',
      }),
  );
  await page.goto("/tests/fixtures/media-review.html?tall-image", {
    waitUntil: "domcontentloaded",
  });
  const image = page.getByRole("img", { name: "Tall screenshot" });
  await expect(image).toHaveJSProperty("naturalHeight", 6000);
  const imagePreview = page.getByRole("button", {
    name: "Open image fullscreen",
  });
  await expect
    .poll(async () => (await imagePreview.boundingBox()).height)
    .toBeLessThanOrEqual(448);
  await expect(image).toHaveCSS("object-fit", "contain");
  await imagePreview.click();
  await expect(
    page.getByRole("dialog", { name: "Image attachment" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(imagePreview).toBeFocused();
});
