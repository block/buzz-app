import { fileURLToPath } from "node:url";
import { setPluginEnabled } from "./plugin-settings.mjs";
import {
  openSettings,
  selectSettingsSection,
  settingsDialog,
  settingsSections,
} from "./navigation.mjs";
import { test, expect } from "./fixture.mjs";

const image = fileURLToPath(
  new URL("../../src/bundled/moderation/icon.png", import.meta.url),
);
const shots = process.env.SHOTS_DIR;

for (const role of ["owner", "member"]) {
  test(`Community icon for a ${role}`, async ({ page, app }) => {
    let published;
    const sent = [];
    await page.route("**/api/relay/primary/query", async (route) => {
      const filters = route.request().postDataJSON();
      if (filters.some((filter) => filter.kinds?.includes(13534)))
        return route.fulfill({ json: [app.membershipSnapshot(role)] });
      return route.continue();
    });
    await page.route("**/api/relay/*/icon-info", (route) =>
      route.fulfill({ json: { icon: published } }),
    );
    await page.route("**/api/relay/*/icon", (route) => {
      const { icon } = route.request().postDataJSON();
      sent.push(icon);
      published = icon || undefined;
      return route.fulfill({ json: { accepted: true, message: "" } });
    });
    await page.goto(app.origin);
    await openSettings(page);
    await selectSettingsSection(page, "Manage plugins");
    await setPluginEnabled(page, "Membership", true);
    const card = settingsSections(page).getByRole("button", {
      name: "Community icon",
      exact: true,
    });
    if (role === "member") {
      await expect(
        settingsSections(page).getByRole("button", {
          name: "Membership",
          exact: true,
        }),
      ).toHaveCount(0);
      await expect(card).toHaveCount(0);
      return;
    }
    await card.click();
    const dialog = settingsDialog(page);
    await expect(dialog.getByText("No icon", { exact: true })).toBeVisible();
    const shoot = async (name) => {
      if (!shots) return;
      for (const scheme of ["light", "dark"]) {
        await page.emulateMedia({ colorScheme: scheme });
        await dialog.screenshot({ path: `${shots}/${name}-${scheme}.png` });
      }
      await page.emulateMedia({ colorScheme: "light" });
    };
    await shoot("empty");

    await dialog.getByLabel("Community icon image").setInputFiles(image);
    await expect(dialog.getByText("Icon updated.")).toBeVisible();
    await expect(dialog.getByText("Icon set", { exact: true })).toBeVisible();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatch(/^data:image\/(png|webp|jpeg);base64,/);
    expect(sent[0].length).toBeLessThanOrEqual(49_152);
    await expect(dialog.locator(`img[src="${sent[0]}"]`)).toBeVisible();
    await shoot("set");

    await dialog.getByRole("button", { name: "Remove icon" }).click();
    await expect(dialog.getByText("Icon removed.")).toBeVisible();
    await expect(dialog.getByText("No icon", { exact: true })).toBeVisible();
    expect(sent).toEqual([sent[0], ""]);
  });
}
