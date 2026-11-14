import { test, expect } from "./fixture.mjs";
import { channelRow } from "./navigation.mjs";
import { showChannels } from "./rail-helpers.mjs";

test.use({ historyCounts: { alpha: 1, beta: 1 } });
test("channel context menus retain keyboard focus without write capabilities", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  await showChannels(page);
  const beta = channelRow(page, "beta");
  const menu = page.getByRole("menu").filter({
    has: page.getByRole("menuitem", { name: "Add to section", exact: true }),
  });
  await beta.click({ button: "right" });
  await expect(menu).toBeVisible();
  // Without write capabilities the menu leaves channel actions out.
  await expect(
    menu.getByRole("menuitem", { name: /^(Mute|Unmute)$/ }),
  ).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(beta).toBeFocused();
  await page.keyboard.press("Shift+F10");
  await expect(menu).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(beta).toBeFocused();
});
