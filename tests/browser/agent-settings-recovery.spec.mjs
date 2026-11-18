import { test, expect } from "./source-fixture.mjs";

test("reverts incompatible agent settings from Previous Versions", async ({
  page,
}) => {
  await page.goto("/tests/fixtures/agent-library.html?settingsRecovery", {
    waitUntil: "domcontentloaded",
  });
  await page.getByRole("gridcell", { name: "Ada", exact: true }).click();
  const history = page.getByRole("button", { name: "Open Previous Versions" });
  await history.focus();
  await history.press("Enter");
  await expect(
    page.getByRole("tab", { name: "Settings", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  const versions = page.getByRole("list", { name: "Previous versions" });
  await expect(
    versions.getByRole("button", { name: /Incompatible/ }),
  ).toBeVisible();
  const compatible = versions.getByRole("button", {
    name: /Latest compatible/,
  });
  await expect(compatible).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() => localStorage.getItem("fixture-recovery-head")),
    )
    .toBeNull();

  await page.setViewportSize({ width: 390, height: 950 });
  await page.evaluate(() => {
    document.documentElement.classList.add("dark");
    document.documentElement.style.fontSize = "20px";
  });
  await compatible.click();
  const revert = page.getByRole("button", { name: "Revert to this" });
  await expect(revert).toBeVisible();
  await revert.click();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const saved = localStorage.getItem("fixture-recovery-head");
        return saved && JSON.parse(JSON.parse(saved).content).settings;
      }),
    )
    .toEqual({ scope: "channel", model: "older-model", effort: "high" });

  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("gridcell", { name: "Ada", exact: true }).click();
  await expect(history).toHaveCount(0);
  await expect(page.getByText(/Settings can't be used/)).toHaveCount(0);
});
