import { test, expect } from "./fixture.mjs";
import {
  closeSettings,
  openPage,
  openSettings,
  selectSettingsSection,
} from "./navigation.mjs";
import { setPluginEnabled } from "./plugin-settings.mjs";

test.use({ pluginFixtures: true, enabledPlugins: ["fixture.new-menu"] });

test("a plugin's New menu item follows the Solo items, opens its page and leaves when the plugin is disabled", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  await openPage(page, "Messages");
  const trigger = page.getByRole("button", { name: "New", exact: true });
  const menu = page.getByRole("menu", { name: "New", exact: true });
  const items = menu.getByRole("menuitem");

  await trigger.click();
  await expect(items).toHaveText([
    "New chat",
    "New workspace",
    "New chat from Linear",
    "New DM",
    "New channel",
    "New section",
  ]);
  await items.filter({ hasText: "New chat from Linear" }).click();
  await expect(menu).toBeHidden();
  await expect(
    page.getByRole("heading", { name: "Start a chat from a Linear issue" }),
  ).toBeVisible();

  await openPage(page, "Messages");
  await openSettings(page);
  await selectSettingsSection(page, "Manage plugins");
  await setPluginEnabled(page, "New menu fixture", false);
  await closeSettings(page);
  await trigger.click();
  await expect(items).toHaveText([
    "New chat",
    "New workspace",
    "New DM",
    "New channel",
    "New section",
  ]);
});
