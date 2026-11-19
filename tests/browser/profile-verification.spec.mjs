import { test, expect } from "./source-fixture.mjs";

// Verify the simplified identity remains readable across themes and text sizes.
for (const fullName of [true, false]) {
  test(`profile presents the verified ${fullName ? "full name" : "username"}`, async ({
    page,
  }, info) => {
    await page.goto(
      `/tests/fixtures/profiles.html?verified-name${fullName ? "" : "&no-full-name"}`,
    );
    await page
      .getByRole("button", { name: "View Viewer profile", exact: true })
      .click();
    const panel = page.getByRole("region", { name: "Profile details" });
    const name = panel.getByRole("heading", {
      name: fullName ? "Viewer Example" : "Viewer",
      exact: true,
    });
    await expect(name).toBeVisible();
    await expect(name.locator("svg")).toHaveCount(0);
    await expect(panel.getByText("@viewer", { exact: true })).toBeVisible();
    await expect(panel.getByText(/Name verified by/)).toHaveCount(0);
    for (const theme of ["light", "dark"]) {
      await page.emulateMedia({ colorScheme: theme });
      for (const width of [480, 1440]) {
        await page.setViewportSize({ width, height: 950 });
        for (const fontSize of ["16px", "24px"]) {
          await page.evaluate((size) => {
            document.documentElement.style.fontSize = size;
          }, fontSize);
          await expect(name).toBeInViewport({ ratio: 1 });
        }
      }
      await panel.screenshot({ path: info.outputPath(`${theme}.png`) });
    }
  });
}

// This browser case covers the real profile panel consuming ordinary profile
// metadata through the enabled provider context. Cache/lifecycle cases are unit tests.
test("renders saved provider fields without a managed relay event", async ({
  page,
}) => {
  await page.goto("/tests/fixtures/profiles.html?managed-profile");
  await page
    .getByRole("button", { name: "View Viewer profile", exact: true })
    .click();
  const panel = page.getByRole("region", { name: "Profile details" });
  await expect(
    panel.getByRole("img", { name: /Map highlighting London/ }),
  ).toBeVisible();
  await expect(
    panel.getByText("Product design", { exact: true }),
  ).toBeVisible();
  await expect(
    panel.getByText("viewer@example.org", { exact: true }),
  ).toBeVisible();
});
