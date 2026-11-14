import { test, expect } from "./source-fixture.mjs";

const viewer = "/tests/fixtures/design-system.html#/design/components/";
const scale = (control) =>
  control.evaluate(
    (element) => parseFloat(getComputedStyle(element).scale) || 1,
  );

// CSS press geometry, native :active, input modality and reduced motion need a
// real browser. Existing specimens mount the production controls and owners.
test("shared controls compress only for enabled pointer presses and recover on release", async ({
  page,
}, testInfo) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto(`${viewer}button`);
  const button = page.getByRole("button", {
    name: "prominent md",
    exact: true,
  });
  await expect(button).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  const layout = await button.evaluate((element) => ({
    width: element.offsetWidth,
    height: element.offsetHeight,
  }));
  await button.hover();
  await page.mouse.down();
  try {
    await expect.poll(() => scale(button)).toBeLessThan(1);
    await button.evaluate(async (element) => {
      await Promise.all(
        element.getAnimations().map((animation) => animation.finished),
      );
    });
    await page.screenshot({
      path: testInfo.outputPath("button-pressed-light.png"),
    });
    expect(
      await button.evaluate((element) => ({
        width: element.offsetWidth,
        height: element.offsetHeight,
      })),
    ).toEqual(layout);
  } finally {
    await page.mouse.up();
  }
  await expect.poll(() => scale(button)).toBe(1);

  // Enter/Space after a pointer focus must also bypass motion.
  await button.focus();
  await page.keyboard.down("Space");
  try {
    expect(await scale(button)).toBe(1);
  } finally {
    await page.keyboard.up("Space");
  }

  await page
    .getByRole("button", { name: "Show disabled", exact: true })
    .click();
  await expect(button).toBeDisabled();
  await button.hover({ force: true });
  await page.mouse.down();
  try {
    expect(await scale(button)).toBe(1);
  } finally {
    await page.mouse.up();
  }

  await page.goto(`${viewer}navigation-item`);
  await page
    .getByRole("button", { name: "Use dark mode", exact: true })
    .click();
  await page.setViewportSize({ width: 800, height: 950 });
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "125%";
  });
  const row = page.getByRole("button", { name: "buzz-design", exact: true });
  await expect(row).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await row.hover();
  await page.mouse.down();
  try {
    await expect.poll(() => scale(row)).toBeLessThan(1);
    await row.evaluate(async (element) => {
      await Promise.all(
        element.getAnimations().map((animation) => animation.finished),
      );
    });
    await page.screenshot({
      path: testInfo.outputPath("row-pressed-dark-enlarged.png"),
    });
  } finally {
    await page.mouse.up();
  }
  await expect.poll(() => scale(row)).toBe(1);
  const option = page
    .locator('.navigation-item[data-variant="option"]')
    .first();
  await option.hover();
  await page.mouse.down();
  try {
    await expect.poll(() => scale(option)).toBeLessThan(1);
  } finally {
    await page.mouse.up();
  }
  await expect.poll(() => scale(option)).toBe(1);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await row.hover();
  await page.mouse.down();
  try {
    expect(await scale(row)).toBe(1);
  } finally {
    await page.mouse.up();
  }
});
