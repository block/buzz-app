import { test, expect } from "./source-fixture.mjs";

// Browser-only contract: the shared settings host saves each agent independently,
// restores the choices after reload, and keeps the chooser usable in narrow panes.
test("Codex Voices persist separately through the settings host", async ({
  page,
}) => {
  await page.goto("/tests/fixtures/agent-library.html?settingsSync=codex", {
    waitUntil: "domcontentloaded",
  });
  await page.getByText("Ada", { exact: true }).click();
  const pane = page.getByRole("tabpanel", { name: "Identity", exact: true });
  const voice = pane.getByRole("button", { name: "Voice", exact: true });
  const preview = pane.getByRole("button", {
    name: "Preview voice",
    exact: true,
  });
  await expect(preview).toBeEnabled();
  await voice.click();
  const locale = page.getByRole("combobox", { name: "Language and region" });
  await expect(locale).toContainText("American English");
  await expect(
    page.getByRole("radio", { name: "Vale", exact: true }),
  ).toHaveCount(0);
  await locale.click();
  await page
    .getByRole("option", { name: "British English", exact: true })
    .click();
  await expect(
    page.getByRole("radio", { name: "Vale", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("radio", { name: "Maple", exact: true }),
  ).toHaveCount(0);
  await locale.click();
  await page
    .getByRole("option", { name: "American English", exact: true })
    .click();
  await page
    .getByRole("radio", { name: "Codex default (Cove)", exact: true })
    .focus();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await expect(
    page.getByRole("dialog", { name: "Choose voice" }),
  ).toBeVisible();
  await expect(
    page.getByRole("radio", { name: "Maple", exact: true }),
  ).toBeChecked();
  await page.keyboard.press("Enter");
  await expect(voice).toBeFocused();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Save", exact: true }),
  ).toHaveCount(0);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByText("Ada", { exact: true }).click();
  await expect(voice).toContainText("Maple");
  await page.getByText("Bo", { exact: true }).click();
  await expect(voice).toContainText("Cove · Default");
  await voice.click();
  await page.getByRole("radio", { name: "Cove", exact: true }).click();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Save", exact: true }),
  ).toHaveCount(0);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByText("Bo", { exact: true }).click();
  await expect(voice).toContainText("Cove");
  for (const { width, dark, fontSize } of [
    { width: 1280, dark: false, fontSize: "16px" },
    { width: 390, dark: true, fontSize: "20px" },
  ]) {
    await page.setViewportSize({ width, height: 950 });
    await page.evaluate(
      ({ dark, fontSize }) => {
        document.documentElement.classList.toggle("dark", dark);
        document.documentElement.style.fontSize = fontSize;
      },
      { dark, fontSize },
    );
    await voice.scrollIntoViewIfNeeded();
    const label = pane.getByText("Voice", { exact: true });
    expect(
      await label.evaluate(
        (el) =>
          el.getBoundingClientRect().height <=
          2 * Number.parseFloat(getComputedStyle(el).lineHeight),
      ),
    ).toBe(true);
    await voice.focus();
    await expect(voice).toBeFocused();
    await page.keyboard.press("Enter");
    const chooser = page.getByRole("dialog", { name: "Choose voice" });
    await expect(chooser).toBeVisible();
    await expect(
      chooser.getByRole("radio", { name: "Cove", exact: true }),
    ).toBeChecked();
    const play = chooser.getByRole("button", {
      name: "Preview Maple",
      exact: true,
    });
    await play.focus();
    await expect(play).toBeFocused();
    expect(
      await chooser.evaluate((el) => el.scrollWidth <= el.clientWidth),
    ).toBe(true);
    await page.keyboard.press("Escape");
    await expect(voice).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(preview).toBeFocused();
    expect(await pane.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(
      true,
    );
  }
});
