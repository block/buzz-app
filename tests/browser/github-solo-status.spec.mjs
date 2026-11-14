import { test, expect } from "./source-fixture.mjs";

// Browser-only: real native row/menu layout and focus do not follow from the
// status derivation matrix or jsdom. This fixture's GitHub data is fictional.
test("approved Solo status remains legible and a failed refresh removes readiness", async ({
  page,
}, info) => {
  await page.goto("/tests/fixtures/github-solo-status.html");
  const row = page.locator('[data-solo-channel-id="sample"]');
  const strip = page.getByRole("img", {
    name: /Review approved.*Ready to merge on GitHub/,
  });
  await expect(strip).toBeVisible();
  const native = await row.elementHandle();
  for (const [width, mode, scale] of [
    [1000, "light", 1],
    [480, "dark", 2],
  ]) {
    await page.setViewportSize({ width, height: 950 });
    await page.evaluate(
      ({ mode, scale }) => {
        document.documentElement.dataset.colorMode = mode;
        document.documentElement.style.fontSize = `${16 * scale}px`;
      },
      { mode, scale },
    );
    await page.evaluate(() => document.fonts.ready);
    await strip.focus();
    await expect(page.getByRole("tooltip")).toContainText(
      "Ready to merge on GitHub",
    );
    await expect
      .poll(() =>
        strip.evaluate((node) => {
          const status = node.getBoundingClientRect();
          const native =
            node.parentElement.firstElementChild.getBoundingClientRect();
          return (
            (status.left >= native.right || status.top >= native.bottom) &&
            status.right <= node.parentElement.getBoundingClientRect().right
          );
        }),
      )
      .toBe(true);
    await page.screenshot({
      path: info.outputPath(`approved-solo-${width}-${mode}.png`),
    });
    await row.focus();
    await row.press("Enter");
    await expect(row).toHaveAttribute("aria-current", "page");
    await row.press("Shift+F10");
    await expect(
      page.getByRole("menuitem", { name: "Rename", exact: true }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(row).toBeFocused();
  }
  await page.getByRole("button", { name: "Simulate failed read" }).click();
  await expect(
    page.getByRole("img", { name: /GitHub read failed; readiness unknown/ }),
  ).toBeVisible();
  await expect(
    page.locator('[data-signal="ready"][data-tone="success"]'),
  ).toHaveCount(0);
  expect(
    await row.evaluate((node, previous) => node === previous, native),
  ).toBe(true);
});
