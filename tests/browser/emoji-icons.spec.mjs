import { test, expect } from "./fixture.mjs";
import { open } from "./timeline.mjs";
import { expectPhosphor } from "./phosphor.mjs";

test("Phosphor picker artwork survives clear-control recreation and remount", async ({
  page,
  app,
}, testInfo) => {
  await open(page, app);
  const trigger = page.getByRole("button", {
    name: "Insert emoji",
    exact: true,
  });
  const search = page.getByRole("searchbox", {
    name: "Search emoji",
    exact: true,
  });
  const clear = page.locator("em-emoji-picker .search .delete");
  for (const mode of ["light", "dark"]) {
    await page.evaluate(
      (mode) => document.documentElement.setAttribute("data-color-mode", mode),
      mode,
    );
    for (const width of [390, 800, 1280]) {
      await page.setViewportSize({ width, height: 950 });
      await trigger.click();
      await expect(search).toBeVisible();
      await expectPhosphor(
        page.locator('[aria-label="Emoji picker"] > svg'),
        "magnifying-glass",
      );
      // Mart deliberately omits category navigation below six columns.
      const navigation = page.locator("em-emoji-picker nav");
      if (width === 390) await expect(navigation).toHaveCount(0);
      else {
        await expect(navigation).toBeVisible();
        for (const [category, icon] of Object.entries({
          "Frequently used": "clock",
          "Smileys & People": "smiley",
          "Animals & Nature": "paw-print",
          "Food & Drink": "orange",
          Activity: "barbell",
          "Travel & Places": "car",
          Objects: "lightbulb",
          Symbols: "shapes",
          Flags: "flag",
        })) {
          await expectPhosphor(
            page
              .locator("em-emoji-picker nav")
              .getByRole("button", {
                name: category,
                exact: true,
              })
              .locator("svg"),
            icon,
          );
        }
      }
      await search.fill("smile");
      await expectPhosphor(clear.locator("svg"), "x-circle");
      await clear.click();
      await expect(search).toHaveValue("");
      await expect(clear).toHaveCount(0);
      await search.fill("wave");
      await expectPhosphor(clear.locator("svg"), "x-circle");
      await expect(clear.locator("path")).toHaveCSS(
        "fill",
        await clear.evaluate((node) => getComputedStyle(node).color),
      );
      await page.screenshot({
        path: testInfo.outputPath(`picker-${mode}-${width}.png`),
      });
      await trigger.click();
      await expect(page.locator("em-emoji-picker")).toHaveCount(0);
    }
  }
});
