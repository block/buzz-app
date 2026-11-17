import { test, expect } from "./source-fixture.mjs";

// Production settings host + recovery dialog, schema validation and signed revision writer.
// Browser coverage owns real Select/focus/dismissal and responsive layout; fault matrices live in Vitest.
test("repairs incompatible saved settings and retains the repaired revision after reload", async ({
  page,
}) => {
  await page.goto("/tests/fixtures/agent-library.html?settingsRecovery", {
    waitUntil: "domcontentloaded",
  });
  await page.getByRole("gridcell", { name: "Ada", exact: true }).click();
  const repair = page.getByRole("button", {
    name: "Repair settings",
    exact: true,
  });
  await repair.click();
  await expect(
    page.getByRole("dialog", { name: "Repair settings", exact: true }),
  ).toContainText("maple");
  await expect(
    page.getByRole("button", { name: "Cancel", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(repair).toBeFocused();
  expect(
    await page.evaluate(() => localStorage.getItem("fixture-recovery-head")),
  ).toBeNull();
  await repair.click();
  const scope = page.getByRole("combobox", { name: "scope", exact: true });
  await scope.focus();
  await scope.press("Enter");
  await page.getByRole("option", { name: "channel", exact: true }).click();
  await page
    .getByRole("textbox", { name: "model", exact: true })
    .fill("chosen-model");
  await page.setViewportSize({ width: 390, height: 950 });
  await page.evaluate(() => {
    document.documentElement.classList.add("dark");
    document.documentElement.style.fontSize = "20px";
  });
  const save = page.getByRole("button", {
    name: "Save repaired settings",
    exact: true,
  });
  await expect(save).toBeInViewport();
  await save.click();
  await expect(repair).toHaveCount(0);
  await expect(page.getByText(/Settings can't be used/)).toHaveCount(0);
  const saved = await page.evaluate(() =>
    JSON.parse(
      JSON.parse(localStorage.getItem("fixture-recovery-head")).content,
    ),
  );
  expect(saved.settings).toEqual({
    scope: "channel",
    model: "chosen-model",
    effort: "high",
  });
  expect(saved.future).toEqual({ keep: true });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("gridcell", { name: "Ada", exact: true }).click();
  await expect(repair).toHaveCount(0);
  await expect(page.getByText(/Settings can't be used/)).toHaveCount(0);
});
