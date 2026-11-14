import { test, expect } from "./fixture.mjs";
import { channelRow } from "./navigation.mjs";
import { addToNewSection, railSection, showChannels } from "./rail-helpers.mjs";

test.use({ productionBroker: true, historyCounts: { alpha: 1, beta: 1 } });

test("renaming a section from its menu persists and keeps its conversations", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  await showChannels(page);
  await addToNewSection(page, channelRow(page, "beta"), "Work");
  const work = railSection(page, "Work");
  const beta = work.locator('[data-rail-row="channel:beta"]');
  await expect(beta).toBeVisible();
  const id = await work.getAttribute("data-rail-section");
  const section = page.locator(`[data-rail-section="${id}"]`);

  await section
    .getByRole("button", { name: "Work", exact: true })
    .click({ button: "right" });
  await page.getByRole("menuitem", { name: "Rename section" }).click();
  // The section renames in place: its title becomes the name field.
  const input = section.getByRole("textbox", { name: "Section name" });
  await expect(input).toBeFocused();
  await expect(input).toHaveValue("Work");
  await input.fill("Projects");
  await input.press("Enter");

  const title = section.getByRole("button", { name: "Projects", exact: true });
  await expect(input).toHaveCount(0);
  await expect(title).toBeFocused();
  await expect(section.locator('[data-rail-row="channel:beta"]')).toBeVisible();

  await page.reload();
  await expect(title).toBeVisible();
  await expect(section.locator('[data-rail-row="channel:beta"]')).toBeVisible();
});
