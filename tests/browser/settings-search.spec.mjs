import { test, expect } from "./fixture.mjs";
import {
  chooseColorMode,
  openSettings,
  settingsDialog,
  settingsSections,
} from "./navigation.mjs";

test.use({ historyCounts: { alpha: 0, beta: 0 } });

// Real dialog navigation, browser focus/scrolling, and responsive sidebar layout
// cannot be established by the search matcher or jsdom component tests.
test("settings search opens and focuses controls across themes, widths and enlarged text", async ({
  page,
  app,
}, info) => {
  await page.goto(app.origin);
  await openSettings(page);
  const dialog = settingsDialog(page);
  const search = dialog.getByRole("searchbox", { name: "Search settings" });
  for (const mode of ["Light", "Dark"]) {
    await settingsSections(page)
      .getByRole("button", { name: "Appearance", exact: true })
      .click();
    await chooseColorMode(page, mode);
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await search.fill("thread");
      await search.press("Tab"); // Clear
      await page.keyboard.press("Tab"); // Result
      await expect(
        settingsSections(page).getByRole("button", {
          name: "Open threads in",
          exact: true,
        }),
      ).toBeFocused();
      await page.keyboard.press("Enter");
      const control = dialog.getByRole("combobox", {
        name: "Open threads in",
        exact: true,
      });
      await expect(control).toBeFocused();
      await expect(control).toBeInViewport();
      await search.fill("message width");
      await settingsSections(page)
        .getByRole("button", { name: /^Message width/ })
        .click();
      await expect(
        dialog.getByRole("combobox", { name: "Message width", exact: true }),
      ).toBeFocused();
      await expect(
        dialog.getByRole("combobox", { name: "Message width", exact: true }),
      ).toBeInViewport();
      await info.attach(`settings-search-${mode}-${width}`, {
        body: await page.screenshot(),
        contentType: "image/png",
      });
      await search.fill("no-such-preference");
      await expect(settingsSections(page).getByRole("status")).toHaveText(
        "No settings found. Try another search.",
      );
      await search.press("Escape");
      await expect(search).toHaveValue("");
      await expect(dialog).toBeVisible();
    }
  }
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "32px";
  });
  await search.fill("font size");
  const result = settingsSections(page).getByRole("button", {
    name: "Interface size",
    exact: true,
  });
  await expect(result).toBeVisible();
  await expect
    .poll(() =>
      settingsSections(page).evaluate(
        (nav) => nav.scrollWidth <= nav.clientWidth,
      ),
    )
    .toBe(true);
  await result.click();
  await expect(
    dialog.getByRole("button", { name: "Decrease interface size" }),
  ).toBeFocused();
});

// A result in another section must land there through the host's navigation,
// and a hidden dependent must land on its prerequisite without changing it.
test("settings search opens other sections and lands on prerequisites without changing them", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  await openSettings(page);
  const dialog = settingsDialog(page);
  const sections = settingsSections(page);
  const search = dialog.getByRole("searchbox", { name: "Search settings" });
  const open = async (section, query, result) => {
    await search.fill("");
    await sections.getByRole("button", { name: section, exact: true }).click();
    await search.fill(query);
    await sections.getByRole("button", { name: result }).click();
  };
  const alerts = dialog.getByRole("switch", {
    name: "Desktop alerts",
    exact: true,
  });
  const sound = dialog.getByRole("switch", { name: "Sound", exact: true });

  await open("Appearance", "sound", /^Sound/);
  await expect(
    page.getByRole("region", { name: "Notifications", exact: true }),
  ).toBeVisible();
  await expect(alerts).toBeChecked();
  await expect(sound).toBeFocused();
  await expect(sound).toBeInViewport();

  await search.fill("");
  await alerts.click();
  await expect(alerts).not.toBeChecked();
  await open("Appearance", "sound", /^Sound/);
  await expect(alerts).toBeFocused();
  await expect(alerts).not.toBeChecked();
  await expect(sound).toHaveCount(0);

  await search.fill("");
  await sections
    .getByRole("button", { name: "Appearance", exact: true })
    .click();
  const density = dialog.getByRole("combobox", {
    name: "Message density",
    exact: true,
  });
  await density.click();
  await page.getByRole("option", { name: "Compact", exact: true }).click();
  await expect(density).toHaveText("Compact");
  await open("Notifications", "message width", /^Message width/);
  await expect(density).toBeFocused();
  await expect(density).toHaveText("Compact");
  await expect(
    dialog.getByRole("combobox", { name: "Message width", exact: true }),
  ).toHaveCount(0);

  // ⌘F / Ctrl+F returns to the search from a control, selecting its query.
  await page.keyboard.press("ControlOrMeta+f");
  await expect(search).toBeFocused();
  await expect
    .poll(() =>
      search.evaluate((input) => [input.selectionStart, input.selectionEnd]),
    )
    .toEqual([0, "message width".length]);
  await expect(
    page.getByRole("search", { name: "Find on screen" }),
  ).toHaveCount(0);

  // Escape clears a query first; on an empty field it is the dialog's again.
  await search.fill("thread");
  await search.press("Escape");
  await expect(search).toHaveValue("");
  await expect(dialog).toBeVisible();
  await search.press("Escape");
  await expect(dialog).toHaveCount(0);
});
