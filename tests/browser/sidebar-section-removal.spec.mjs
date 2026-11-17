import { test, expect } from "./fixture.mjs";
import { channelRow } from "./navigation.mjs";
import { addToNewSection, railSection, showChannels } from "./rail-helpers.mjs";

// Real context-menu portal, row relocation and cold reload of the rail's own
// sections, which this device keeps. Layout records stay in rail-layout's Vitest.
test.use({ productionBroker: true, historyCounts: { alpha: 1, beta: 1 } });

test("removing a section keeps its conversations in Team and survives reload", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  await showChannels(page);
  await addToNewSection(page, channelRow(page, "beta"), "Work");
  const work = railSection(page, "Work");
  await expect(work.locator('[data-rail-row="channel:beta"]')).toBeVisible();
  const title = work.getByRole("button", { name: "Work", exact: true });
  await title.focus();
  await page.keyboard.press("Shift+F10");
  await page
    .getByRole("menuitem", { name: "Remove section", exact: true })
    .click();
  await expect(work).toHaveCount(0);
  await expect(channelRow(page, "beta")).toBeVisible();
  await page.reload();
  await showChannels(page);
  await expect(railSection(page, "Work")).toHaveCount(0);
  await channelRow(page, "beta").click();
  await expect(
    page.getByRole("textbox", { name: "Message #Beta", exact: true }),
  ).toBeVisible();
});
