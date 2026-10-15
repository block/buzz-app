import { test, expect } from "./source-fixture.mjs";

// Real browser computed styles and pointer/focus behavior.
test("delivery message presentation", async ({ page }) => {
  await page.goto("/tests/fixtures/message-gallery.html?bubble=blue");
  for (const theme of ["light", "dark"]) {
    await page.evaluate((theme) => {
      document.documentElement.dataset.colorMode = theme;
    }, theme);
    const retry = page
      .locator('[data-message-id="delivery-failed"]')
      .getByRole("button", { name: "Retry", exact: true });
    await retry.hover();
    await expect(page.getByRole("tooltip")).toContainText("Couldn’t send");
    await page.mouse.move(0, 0);
    await retry.focus();
    await expect(page.getByRole("tooltip")).toContainText("Couldn’t send");
    await retry.press("Tab");
  }
});
