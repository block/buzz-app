import { test, expect } from "./source-fixture.mjs";
import { watchPageErrors } from "./page-errors.mjs";

// Real font metrics, persisted browser preferences and popup collisions need a browser.
test("badge activity persists and fits light/dark settings at narrow widths and enlarged text", async ({
  page,
}, info) => {
  const errors = watchPageErrors(page);
  await page.goto("/tests/fixtures/notification-badges.html");
  const choice = page.getByRole("combobox", { name: "Badge activity" });
  await expect(choice).toHaveText("All unread activity");
  await choice.click();
  await page
    .getByRole("option", { name: "Mentions and direct messages", exact: true })
    .click();
  await expect(choice).toHaveText("Mentions and direct messages");
  await page.reload();
  await expect(choice).toHaveText("Mentions and direct messages");
  await page.evaluate(() => document.fonts.ready);
  for (const mode of ["light", "dark"]) {
    for (const size of [16, 32]) {
      await page.evaluate(
        ({ mode, size }) => {
          document.documentElement.dataset.colorMode = mode;
          document.documentElement.style.fontSize = `${size}px`;
        },
        { mode, size },
      );
      for (const width of [800, 390]) {
        await page.setViewportSize({ width, height: 900 });
        await expect
          .poll(() =>
            choice.evaluate((element) => {
              const row = element.closest(".buzz-preference-row");
              const bounds = row.getBoundingClientRect();
              const control = element.getBoundingClientRect();
              const labelElement = row.querySelector(
                ".buzz-preference-row-label",
              );
              const label = labelElement.getBoundingClientRect();
              const context = document.createElement("canvas").getContext("2d");
              context.font = getComputedStyle(labelElement).font;
              const wordWidth = Math.max(
                ...labelElement.textContent
                  .split(/\s+/)
                  .map((word) => context.measureText(word).width),
              );
              return (
                control.right <= bounds.right &&
                (control.left >= label.right || control.top >= label.bottom) &&
                label.width >= wordWidth &&
                bounds.right <= innerWidth
              );
            }),
          )
          .toBe(true);
        await choice.click();
        const option = page.getByRole("option", {
          name: "Mentions and direct messages",
          exact: true,
        });
        await expect(option).toBeVisible();
        await expect
          .poll(() =>
            option.evaluate((element) => {
              const bounds = element.getBoundingClientRect();
              return bounds.left >= 0 && bounds.right <= innerWidth;
            }),
          )
          .toBe(true);
        await page.keyboard.press("Escape");
        await expect(choice).toBeFocused();
        if (width === 390)
          await page.screenshot({
            path: info.outputPath(`badges-${mode}-${size}.png`),
          });
      }
    }
  }
  expect(errors.unexplained()).toEqual([]);
});
