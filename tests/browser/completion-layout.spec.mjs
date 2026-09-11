import { test, expect } from "./fixture.mjs";

test("completion menu stays reachable in the production channel layout", async ({
  page,
  app,
}, testInfo) => {
  await page.goto(app.origin);
  await page
    .getByRole("navigation", { name: "Pages", exact: true })
    .getByRole("button", { name: "Messages" })
    .click();
  const input = page.getByRole("textbox", {
    name: "Message #Alpha",
    exact: true,
  });
  for (const [width, height] of [
    [1280, 832],
    [800, 600],
    [480, 400],
    [390, 844],
  ]) {
    await page.setViewportSize({ width, height });
    await input.fill(":sm");
    const option = page.getByRole("option").first();
    await expect(option).toBeVisible();
    await expect
      .poll(() =>
        option.evaluate((el) => {
          const r = el.getBoundingClientRect();
          return el.contains(
            document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2),
          );
        }),
      )
      .toBe(true);
    await page.screenshot({
      path: testInfo.outputPath(`completion-${width}x${height}.png`),
    });
    await option.click();
    await expect(input).toBeFocused();
    await expect(input).not.toHaveValue(":sm");
  }
});
