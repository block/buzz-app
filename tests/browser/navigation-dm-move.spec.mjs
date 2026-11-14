import { expect, test } from "./fixture.mjs";
import { channelRow, rail } from "./navigation.mjs";
import {
  addToNewSection,
  openSectionMenu,
  railSection,
} from "./rail-helpers.mjs";

test.use({
  productionBroker: true,
  dmLabels: true,
  dmMembers: { "dm-move": [0] },
  historyCounts: { alpha: 1, beta: 1 },
  viewport: { width: 1280, height: 720 },
  video: "on",
});

// The browser boundary here is real menu focus/portal interaction plus the
// rail's saved layout across a full page reload. Component tests cover the
// placement state transitions without app startup.
test("a DM's row menu keeps it in a section and restores it there after reload", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  await rail(page).locator('[data-rail-team-view="dms"]').click();
  const dm = channelRow(page, "dm-move");
  await expect(dm).toBeVisible();
  const menu = await openSectionMenu(page, dm);
  await expect(menu).toHaveAccessibleName(/Alice Fixture/);
  await page.screenshot({ path: test.info().outputPath("dm-move-menu.png") });
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");

  await addToNewSection(page, dm, "Work");
  const work = railSection(page, "Work");
  const placed = work.locator('[data-rail-row="channel:dm-move"]');
  await expect(placed).toBeVisible();
  // A conversation stays in Team: the section holds it as well.
  await expect(dm).toBeVisible();

  await page.reload();
  await expect(placed).toBeVisible();

  await placed.getByRole("button").first().focus();
  await page.keyboard.press("Shift+F10");
  await page
    .getByRole("menuitem", { name: "Remove from section", exact: true })
    .click();
  await expect(placed).toHaveCount(0);

  await page.reload();
  await expect(work).toBeVisible();
  await expect(placed).toHaveCount(0);
});
