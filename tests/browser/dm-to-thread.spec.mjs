import { test, expect } from "./fixture.mjs";
import { open } from "./timeline.mjs";

// Real app wiring, menu portals/focus and browser history cannot be established
// by protocol tests. The shared fixture supplies only a local signed relay.
test.use({
  productionBroker: true,
  dmLabels: true,
  dmMembers: { "dm-convert": [0] },
  historyCounts: { alpha: 1, beta: 1 },
});

test("DM conversion dialog follows history and remains usable in both themes and narrow layouts", async ({
  page,
  app,
}) => {
  await open(page, app);
  await page.locator('[data-channel-id="dm-convert"]').first().click();
  await page
    .getByRole("button", { name: "Channel actions", exact: true })
    .click();
  const convert = page.getByRole("menuitem", {
    name: "Convert to thread",
    exact: true,
  });
  await expect(convert).toBeVisible();
  await convert.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", {
    name: "Convert to thread",
    exact: true,
  });
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Request approval" }),
  ).toBeDisabled();
  await expect(
    dialog.getByRole("spinbutton", { name: "Approval window (hours)" }),
  ).toHaveValue("24");
  await dialog
    .getByRole("spinbutton", { name: "Approval window (hours)" })
    .fill("12");
  await page.goBack();
  await expect(dialog).toHaveCount(0);
  await page.goForward();
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole("spinbutton", { name: "Approval window (hours)" }),
  ).toHaveValue("12");
  for (const theme of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme: theme });
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 850 });
      await expect(dialog).toBeVisible();
      const bounds = await dialog.boundingBox();
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
      await page.screenshot({
        path: test.info().outputPath(`conversion-${theme}-${width}.png`),
      });
    }
  }
  await page.evaluate(() => {
    document.body.style.zoom = "1.25";
  });
  await expect(
    dialog.getByRole("spinbutton", { name: "Approval window (hours)" }),
  ).toBeVisible();
  await page.screenshot({
    path: test.info().outputPath("conversion-enlarged.png"),
  });
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await page.goBack();
  await page.goForward();
  await expect(dialog).toHaveCount(0);
});
