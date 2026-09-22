import { test, expect } from "./source-fixture.mjs";

// Exercise shared shell controls through the real app entry, not a specimen.
// Composer layer-order coverage belongs with the rich-editor integration.
test("app startup preserves shared shell control styling", async ({ page }) => {
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
      const controls = [
        page.getByRole("button", { name: "Go back", exact: true }),
        page.getByRole("button", { name: "Go forward", exact: true }),
        page.getByRole("button", { name: "Find a page", exact: true }),
      ];
      for (const control of controls) {
        await expect(control).toBeVisible();
        await expect(control).toHaveCSS("padding-left", "0px");
        await expect(control).toHaveCSS("border-top-width", "0px");
      }
    }
  }
});
