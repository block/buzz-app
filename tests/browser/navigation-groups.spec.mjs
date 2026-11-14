import { test, expect } from "./fixture.mjs";
import { channelRow, rail } from "./navigation.mjs";
import {
  addToNewSection,
  openSectionMenu,
  railSection,
  showChannels,
} from "./rail-helpers.mjs";

test.use({
  productionBroker: true,
  historyCounts: { alpha: 1, beta: 1 },
});

// Browser-owned keyboard nesting and portal focus for the rail's own sections,
// which this device keeps. Layout records stay in rail-layout's Vitest.
test("a row's section menu nests from the keyboard, and its moves survive reload", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  await showChannels(page);
  await addToNewSection(page, channelRow(page, "beta"), "Work");
  const work = railSection(page, "Work");
  const inWork = work.locator('[data-rail-row="channel:beta"]');
  await expect(inWork).toBeVisible();

  // A section made empty, from the rail's own button.
  await rail(page)
    .getByRole("button", { name: "New section", exact: true })
    .click();
  const create = page.getByRole("dialog", { name: "Create new section" });
  await create.getByRole("textbox", { name: "Section name" }).fill("Later");
  await create.getByRole("button", { name: "Create", exact: true }).click();
  await expect(create).toHaveCount(0);
  const later = railSection(page, "Later");
  const inLater = later.locator('[data-rail-row="channel:beta"]');
  await expect(later).toBeVisible();

  // The submenu opens and closes from the keyboard around its trigger.
  const menu = await openSectionMenu(page, inWork.getByRole("button").first());
  const trigger = page.getByRole("menuitem", {
    name: "Move to section",
    exact: true,
  });
  await page.keyboard.press("ArrowLeft");
  await expect(trigger).toBeFocused();
  await expect(menu).toHaveCount(0);
  await page.keyboard.press("ArrowRight");
  await expect(menu).toBeVisible();
  const newSection = menu.getByRole("menuitem", {
    name: "New section…",
    exact: true,
  });
  // Establish keyboard ownership of the reopened submenu before End.
  await expect(menu.locator('[role="menuitem"]:focus')).toHaveCount(1);
  await page.keyboard.press("End");
  await expect(newSection).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(
    menu.getByRole("menuitem", { name: "Later", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(menu).toHaveCount(0);
  await expect(inLater).toBeVisible();
  await expect(inWork).toHaveCount(0);
  await page.reload();
  await expect(inLater).toBeVisible();
  await expect(inWork).toHaveCount(0);

  // Remove from section leaves the conversation in Team only.
  await inLater.getByRole("button").first().focus();
  await page.keyboard.press("Shift+F10");
  await page
    .getByRole("menuitem", { name: "Remove from section", exact: true })
    .click();
  await expect(inLater).toHaveCount(0);
  await page.reload();
  await expect(later).toBeVisible();
  await expect(inLater).toHaveCount(0);
});

// The menu-to-dialog handoff and the dialog's fit need real layout and focus.
test("the new-section dialog takes focus from the row menu, fits narrow widths, and returns to its row", async ({
  page,
  app,
}, testInfo) => {
  await page.goto(app.origin);
  await showChannels(page);
  const row = channelRow(page, "beta");
  const menu = await openSectionMenu(page, row);
  await menu
    .getByRole("menuitem", { name: "New section…", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "Move to new section" });
  const field = dialog.getByRole("textbox", {
    name: "Section name",
    exact: true,
  });
  await expect(field).toBeFocused();
  await expect(page.getByRole("menu")).toHaveCount(0);
  await dialog.evaluate(async (element) => {
    await Promise.allSettled(
      element.getAnimations().map((animation) => animation.finished),
    );
  });
  await expect(field).toBeFocused();
  await expect(dialog.locator("label")).toHaveCount(0);
  await expect(dialog).not.toHaveAttribute("aria-describedby");
  for (const width of [1440, 360]) {
    await page.setViewportSize({ width, height: 950 });
    const layout = await dialog.evaluate((element) => {
      const box = element.getBoundingClientRect();
      return {
        width: element.clientWidth,
        scrollWidth: element.scrollWidth,
        left: box.left,
        right: box.right,
        viewport: window.innerWidth,
      };
    });
    expect(layout.left).toBeGreaterThanOrEqual(0);
    expect(layout.scrollWidth).toBeLessThanOrEqual(layout.width);
    expect(layout.right).toBeLessThanOrEqual(layout.viewport);
  }
  await dialog.screenshot({
    path: testInfo.outputPath("create-section-narrow.png"),
  });
  await page.setViewportSize({ width: 1440, height: 950 });
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(row).toBeFocused();
});
