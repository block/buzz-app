import {
  nativeMediaMenu,
  checkViewerDownloadFeedback,
} from "./media-menu-download.mjs";
import { test, expect } from "./source-fixture.mjs";

// Browser-only: CSS visibility, real inert hit testing and keyboard focus.
// Keep the plain viewer's notice-arrival matrix out of full-app startup.
test("plain media viewer hides inert notices and restores their controls", async ({
  page,
}) => {
  await nativeMediaMenu(page);
  await page.goto("/tests/fixtures/media-notices.html");
  const opener = page.getByRole("link", { name: "Open image attachment" });
  const host = page.locator("#buzz-toast-root");
  const notice = host.getByText("Ready to update!");
  const viewer = page.getByRole("dialog", {
    name: "Image attachment",
    exact: true,
  });

  // Arrival after opening must be hidden too, without dismissing the notice.
  await opener.click();
  await expect(viewer).toBeVisible();
  await expect(
    viewer.getByRole("button", { name: "Close fullscreen viewer" }),
  ).toBeFocused();
  await page.evaluate(() => window.finishDownload());
  await expect(notice).toBeAttached();
  await expect(notice).toBeHidden();
  await expect(host).toHaveAttribute("inert", "");
  await checkViewerDownloadFeedback(page, viewer, notice);
  await page.keyboard.press("Escape");
  await expect(viewer).toHaveCount(0);
  await expect(opener).toBeFocused();
  await expect(notice).toBeVisible();

  // Existing notice, different host appearance/size, and an explicit close.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => {
    document.documentElement.dataset.colorMode = "dark";
    document.documentElement.style.fontSize = "20px";
  });
  const card = await notice.elementHandle();
  await opener.click();
  await expect(viewer).toBeVisible();
  await expect(notice).toBeHidden();
  for (const key of ["Tab", "Shift+Tab", "F6"]) {
    await page.keyboard.press(key);
    await expect
      .poll(() => viewer.evaluate((el) => el.contains(document.activeElement)))
      .toBe(true);
  }
  await expect(
    page.getByText("Other inert content remains visible"),
  ).toBeVisible();
  await viewer.getByRole("button", { name: "Close fullscreen viewer" }).click();
  await expect(viewer).toHaveCount(0);
  await expect(opener).toBeFocused();
  await expect(notice).toBeVisible();
  expect(await card.evaluate((el) => el.isConnected)).toBe(true);

  // Cleanup must preserve a host that was already inert (e.g. startup).
  await host.evaluate((el) => {
    el.inert = true;
    el.setAttribute("aria-hidden", "true");
  });
  await opener.click();
  await expect(viewer).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(viewer).toHaveCount(0);
  await expect(opener).toBeFocused();
  await expect(host).toHaveAttribute("inert", "");
  await expect(host).toHaveAttribute("aria-hidden", "true");
  await expect(notice).toBeHidden();
  await host.evaluate((el) => {
    el.inert = false;
    el.removeAttribute("aria-hidden");
  });
  await host.getByRole("button", { name: "Update now", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => window.report))
    .toEqual({
      installs: 1,
      restarts: 1,
    });
  await host
    .getByRole("button", { name: "Dismiss update notification" })
    .click();
  await expect(notice).toHaveCount(0);
});
