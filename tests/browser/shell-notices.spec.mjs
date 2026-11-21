import {
  openSettings,
  selectSettingsSection,
  settingsDialog,
} from "./navigation.mjs";
import { test, expect } from "./fixture.mjs";
import { open } from "./timeline.mjs";

test.use({ pluginFixtures: true, enabledPlugins: ["fixture.notices"] });

const tabKey = (browserName) =>
  browserName === "webkit" && process.platform === "darwin" ? "Alt+Tab" : "Tab";

const question = (page) =>
  page.getByRole("dialog", { name: "Let Fixture delete a.txt?" });

test("a plugin's notice shows on any page and takes the owner's answer over Settings", async ({
  page,
  app,
}) => {
  await open(page, app);
  const ask = question(page);
  await expect(ask).toBeVisible();
  await expect(ask).toContainText("From Notice fixture");
  await openSettings(page);
  await expect(ask).toBeVisible();
  await page.getByRole("dialog", { name: "Fixture is waiting" }).hover();
  await ask.getByRole("button", { name: "Allow once" }).click();
  await expect(ask).toHaveCount(0);
  const answered = page.getByRole("dialog", { name: "Answered once" });
  await expect(answered).toBeVisible();
  await settingsDialog(page).press("Escape");
  await expect(settingsDialog(page)).toHaveCount(0);
  await expect(answered).toBeVisible();
});

async function reachOverSettings(page, app) {
  await open(page, app);
  const ask = question(page);
  await expect(ask).toBeVisible();
  await openSettings(page);
  const close = settingsDialog(page).getByRole("button", {
    name: "Close Settings",
    exact: true,
  });
  await close.focus();
  await page.keyboard.press("F6");
  const card = page.locator("[data-sonner-toast]", { has: ask });
  await expect(card).toBeFocused();
  await expect(card).toHaveCSS("outline-style", "solid");
  return { ask, card, close };
}

test("F6 reaches a waiting notice over Settings, and Enter on an action answers it", async ({
  page,
  app,
  browserName,
}) => {
  const tab = tabKey(browserName);
  const { ask, close } = await reachOverSettings(page, app);
  await page.keyboard.press(tab);
  await page.keyboard.press(tab);
  await expect(ask.getByRole("button", { name: "Allow once" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(ask).toHaveCount(0);
  await expect(
    page.getByRole("dialog", { name: "Answered once" }),
  ).toBeVisible();
  await expect(settingsDialog(page)).toBeVisible();
  await expect(close).toBeFocused();
});

test("F6 and Tab keep focus between a waiting notice and Settings, and Escape on the notice refuses it", async ({
  page,
  app,
  browserName,
}) => {
  const tab = tabKey(browserName);
  const { ask, card, close } = await reachOverSettings(page, app);
  await page.keyboard.press(`Shift+${tab}`);
  await expect(close).toBeFocused();
  await page.keyboard.press("F6");
  await expect(card).toBeFocused();
  await page.keyboard.press(tab);
  await page.keyboard.press(tab);
  await page.keyboard.press(tab);
  await expect(ask.getByRole("button", { name: "Deny" })).toBeFocused();
  await page.keyboard.press(tab);
  await expect(close).toBeFocused();
  await page.keyboard.press("F6");
  await expect(card).toBeFocused();
  await page.keyboard.press("F6");
  await expect(close).toBeFocused();
  await page.keyboard.press("F6");
  await expect(card).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(ask).toHaveCount(0);
  await expect(
    page.getByRole("dialog", { name: "Answered nothing" }),
  ).toBeVisible();
  await expect(settingsDialog(page)).toBeVisible();
  await expect(close).toBeFocused();
});

test("over Settings, a notice without choices keeps its Tab order and the focus a click gives it", async ({
  page,
  app,
  browserName,
}) => {
  const tab = tabKey(browserName);
  await open(page, app);
  await expect(question(page)).toBeVisible();
  await openSettings(page);
  await selectSettingsSection(page, "Appearance");
  await page.evaluate(() => {
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key === "buzz-clock.v1")
        throw new DOMException("Full", "QuotaExceededError");
      return setItem.call(this, key, value);
    };
  });
  await page.getByRole("switch", { name: "Show seconds" }).click();
  const unsaved = page.getByRole("dialog", {
    name: "Clock preference wasn’t saved",
  });
  await unsaved.getByText("Clock preference wasn’t saved").click();
  await expect(
    page.locator("[data-sonner-toast]", { has: unsaved }),
  ).toBeFocused();
  await page.keyboard.press(tab);
  await expect(
    unsaved.getByRole("button", { name: "Retry saving clock preference" }),
  ).toBeFocused();
  await page.keyboard.press(tab);
  await expect(
    page.locator("[data-sonner-toast]", {
      has: page.getByRole("dialog", { name: "Fixture is waiting" }),
    }),
  ).toBeFocused();
  await question(page).getByText("Let Fixture delete a.txt?").click();
  await expect(
    page.locator("[data-sonner-toast]", { has: question(page) }),
  ).toBeFocused();
  const retry = unsaved.getByRole("button", {
    name: "Retry saving clock preference",
  });
  await unsaved.hover();
  await retry.click();
  await expect(retry).toBeFocused();
});
