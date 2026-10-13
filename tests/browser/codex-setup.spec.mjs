import { test, expect } from "./source-fixture.mjs";

test("Buzz-specific Codex sign-in guidance fits narrow enlarged layouts and remains keyboard actionable", async ({
  page,
}) => {
  await page.goto("/tests/fixtures/codex-setup.html?signed-out");
  await expect(page.getByRole("alert")).toContainText("CODEX_HOME=");
  const retry = page.getByRole("button", { name: "Check again" });
  await expect(retry).toBeEnabled();
  for (const theme of ["light", "dark"]) {
    await page.setViewportSize({ width: 390, height: 900 });
    await page.evaluate((theme) => {
      document.documentElement.dataset.colorMode = theme;
      document.documentElement.style.setProperty("--buzz-text-scale", "2");
    }, theme);
    await page.evaluate(() => document.fonts.ready);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await retry.focus();
    await page.keyboard.press("Enter");
    await expect(retry).toBeEnabled();
    await expect(page.getByRole("alert")).toContainText("sign-in for Buzz");
  }
});
