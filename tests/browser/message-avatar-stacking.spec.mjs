import { test, expect } from "./source-fixture.mjs";

// Stacking order requires actual browser computed styles.
test("later reply avatars stack above earlier avatars", async ({ page }) => {
  await page.goto("/tests/fixtures/message-gallery.html?accent=blue");
  const avatars = page.locator(
    '[data-message-id="thread"] [data-avatar-stack] > [data-avatar-shape]',
  );
  // The gallery thread has four repliers, and four fit without a count.
  await expect(avatars).toHaveCount(4);
  for (let index = 0; index < 4; index++)
    await expect(avatars.nth(index)).toHaveCSS("z-index", String(index + 1));
});
