import { test, expect } from "./source-fixture.mjs";

// The actual app entry imports Composer transitively. An isolated component
// fixture cannot prove that this import preserves the host's CSS layer order.
test("app startup keeps shell and composer styles above generic button defaults", async ({
  page,
}) => {
  await page.goto("/");
  const home = page
    .getByRole("navigation", { name: "Pages" })
    .getByRole("button", { name: "Home", exact: true });
  const messages = page
    .getByRole("navigation", { name: "Pages" })
    .getByRole("button", { name: "Messages", exact: true });
  await expect(home).toBeVisible();
  for (const dark of [false, true]) {
    await page.evaluate((dark) => {
      document.documentElement.classList.toggle("dark", dark);
      document.documentElement.dataset.colorMode = dark ? "dark" : "light";
    }, dark);
    for (const width of [390, 820, 1440]) {
      await page.setViewportSize({ width, height: 950 });
      await expect(home).toHaveCSS("border-top-width", "0px");
      await expect(messages).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
      const controls = page.locator(".shell-icon");
      for (const control of await controls.all()) {
        await expect(control).toHaveCSS("padding-left", "0px");
        await expect(control).toHaveCSS("border-top-width", "0px");
      }
    }
  }
});
