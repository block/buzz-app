import { test, expect } from "./source-fixture.mjs";

test("Codex provider sign-in fits narrow enlarged layouts and remains keyboard actionable", async ({
  page,
}) => {
  await page.goto("/tests/fixtures/codex-setup.html?signed-out");
  await expect(page.getByRole("alert")).toContainText("sign in");
  const retry = page.getByRole("button", { name: "Sign in" });
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
    await expect(page.getByRole("alert")).toContainText("sign in");
  }
});

test("an unavailable other store leaves readable history with an explicit alert", async ({
  page,
}) => {
  await page.goto("/tests/fixtures/codex-setup.html?partial-history");
  await page.getByText("Runtime diagnostics").click();
  await page.getByRole("button", { name: "View transcript" }).click();
  await expect(
    page.getByText("The existing conversation history is available."),
  ).toBeVisible();
  await expect(page.getByRole("alert")).toContainText(
    "Some conversation history could not be read",
  );
  await page.setViewportSize({ width: 390, height: 900 });
  await page.evaluate(() =>
    document.documentElement.style.setProperty("--buzz-text-scale", "2"),
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
