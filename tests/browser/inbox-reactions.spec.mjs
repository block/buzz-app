import { test, expect } from "./fixture.mjs";
import {
  openPage,
  openSettings,
  selectSettingsSection,
  chooseColorMode,
  closeSettings,
} from "./navigation.mjs";

// Proves the real Inbox menu, remote history owner and conversation tab wiring.
// Ownership, deletion and access race matrices stay in colocated Vitest tests.
test.use({
  productionBroker: true,
  historyCounts: { alpha: 1, beta: 0 },
  screenshot: "off",
});
test("reaction history opens the original message from Inbox", async ({
  page,
  app,
}) => {
  const target = app.histories.get("primary/alpha")[0];
  app.serveReaction(target);
  await page.goto(app.origin);
  await openPage(page, "Inbox");
  const inbox = page.getByRole("region", { name: "Inbox", exact: true });
  await inbox
    .getByRole("button", { name: "Inbox filters", exact: true })
    .click();
  await page
    .getByRole("menuitemradio", { name: "Reactions", exact: true })
    .click();
  const row = inbox.getByRole("button", {
    name: /^Open message reacted to by /,
  });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("✅");
  for (const theme of ["Light", "Dark"]) {
    await openSettings(page);
    await selectSettingsSection(page, "Appearance");
    await chooseColorMode(page, theme);
    await closeSettings(page);
    for (const width of [390, 1280]) {
      await page.setViewportSize({ width, height: 950 });
      await page.evaluate(() => {
        document.documentElement.style.fontSize = "20px";
      });
      await expect(row).toBeInViewport();
    }
  }
  await row.focus();
  await page.keyboard.press("Enter");
  await expect(inbox.locator(`[data-message-id="${target.id}"]`)).toBeVisible();
});
