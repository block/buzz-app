import { test, expect } from "./fixture.mjs";
import { open } from "./timeline.mjs";

// Browser-only boundary: Base UI restores focus when a popup's exit
// transition ends. A slow transition lets the user's next click land first.
const slowMenus = `:is(.buzz-menu-popup, .buzz-popover-popup) {
  transition-duration: 400ms !important;
}`;
const settled = (locator) =>
  expect
    .poll(() => locator.evaluate((element) => element.getAnimations().length))
    .toBe(0);

test("closing a menu keeps focus where the user moved it", async ({
  page,
  app,
}) => {
  await open(page, app);
  await page.addStyleTag({ content: slowMenus });
  const row = page
    .getByRole("navigation", {
      name: "Subscribed channels",
      includeHidden: true,
    })
    .locator('[data-channel-id="beta"]');
  const rowMenu = page.getByRole("menu", { name: "Actions for Beta" });
  const composer = page.getByRole("textbox", {
    name: "Message #Alpha",
    exact: true,
  });

  await row.click({ button: "right" });
  await settled(rowMenu);
  await page.keyboard.press("Escape");
  await composer.click();
  await expect(composer).toBeFocused();
  // Only now does the row menu finish closing. Its explicit final focus (the
  // row) must not pull focus back out of the composer.
  await expect(rowMenu).toHaveCount(0);
  await expect(composer).toBeFocused();

  // With nothing else focused, Escape still returns focus to the row.
  await row.click({ button: "right" });
  await settled(rowMenu);
  await page.keyboard.press("Escape");
  await expect(rowMenu).toHaveCount(0);
  await expect(row).toBeFocused();
});
