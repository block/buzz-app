import { fileURLToPath } from "node:url";
import { test, expect } from "./fixture.mjs";
import { open } from "./timeline.mjs";

test("a GIF stays collapsed after reload and collapsing a playing clip stops it", async ({
  page,
  app,
}) => {
  await page.route("**/api/relay/primary/media?**", (route) => {
    const gif = new URL(route.request().url()).searchParams
      .get("url")
      .endsWith(".gif");
    return route.fulfill({
      path: fileURLToPath(
        new URL(
          gif
            ? "../fixtures/attachment-media/animated.gif"
            : "../fixtures/message-gallery/assets/sample.mp4",
          import.meta.url,
        ),
      ),
      contentType: gif ? "image/gif" : "video/mp4",
    });
  });
  await open(page, app);
  const history = page.getByRole("region", { name: "Channel message history" });
  const gif = app.append(
    "primary",
    "alpha",
    "![Animated](https://primary.example/media/animated.gif)",
  );
  const imageRow = history.locator(`[data-message-id="${gif.id}"]`);
  const image = imageRow.getByRole("link", { name: "Open image attachment" });
  const toggle = imageRow.getByRole("button", { name: "Image", exact: true });
  await expect(image).toBeVisible();
  await toggle.click();
  await page.reload();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(image).toHaveCount(0);
  await toggle.click();
  await expect(image).toBeVisible();

  const clip = app.append(
    "primary",
    "alpha",
    "Video clip",
    true,
    true,
    undefined,
    undefined,
    [["imeta", "url https://primary.example/media/sample.mp4", "m video/mp4"]],
  );
  const videoRow = history.locator(`[data-message-id="${clip.id}"]`);
  const video = videoRow.locator("video");
  await videoRow
    .getByRole("button", { name: "Play video", exact: true })
    .click();
  await expect(video).toHaveJSProperty("paused", false);
  const player = await video.elementHandle();
  await videoRow.getByRole("button", { name: "Video", exact: true }).click();
  await expect(video).toHaveCount(0);
  await expect
    .poll(() => player.evaluate((element) => element.paused))
    .toBe(true);
});
