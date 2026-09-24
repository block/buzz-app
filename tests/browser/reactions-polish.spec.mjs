import { expect } from "@playwright/test";
import { test } from "./source-fixture.mjs";

test("reaction pills wrap, preview, toggle, and add from the inline control", async ({
  page,
}, testInfo) => {
  await page.route("**/emoji-media/**", (route) =>
    route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16"><path d="M2 4Q4 1 8 2q6-1 6 5 0 7-6 7Q1 14 2 8Z" fill="#82d93e"/><circle cx="6" cy="6" r="1"/><circle cx="11" cy="6" r="1"/><path d="M5 10q3 3 6 0" fill="none" stroke="#172710" stroke-width="1"/></svg>',
    }),
  );
  await page.goto("/tests/fixtures/emoji.html?reactions&wrap&narrow");
  const message = page.locator("[data-message-id]").first();
  const row = message.getByTestId("reaction-row");
  const pills = row.locator("button[data-reaction]");
  await expect(pills).toHaveCount(12);
  const order = () =>
    pills.evaluateAll((items) => items.map((item) => item.dataset.reaction));
  const initialOrder = await order();
  const tops = await pills.evaluateAll((items) =>
    items.map((item) => item.getBoundingClientRect().top),
  );
  expect(new Set(tops).size).toBeGreaterThan(1);

  const custom = row.locator('button[data-reaction=":party:"]');
  const native = row.locator('button[data-reaction="👍"]');
  await expect(custom.locator("img")).toHaveCSS("object-fit", "contain");
  await expect(custom.locator("img")).toHaveCSS("width", "14px");
  await expect(native.locator("span").first()).toHaveCSS("font-size", "12px");
  await expect(custom).toHaveCSS("height", "28px");
  const plus = row.getByRole("button", { name: "Add reaction" });
  await expect(plus).toHaveCSS("width", "28px");
  await expect(plus).toHaveCSS("height", "28px");
  await message.screenshot({ path: testInfo.outputPath("reaction-row.png") });

  await custom.hover();
  const tooltip = page.locator('.buzz-preview-card[role="tooltip"][data-open]');
  await expect(tooltip).toHaveCount(0);
  await page.waitForTimeout(300);
  await expect(tooltip).toHaveCount(0);
  await expect(tooltip).toBeVisible({ timeout: 2500 });
  await expect(tooltip.locator("img")).toHaveCount(1);
  await expect(tooltip).toContainText(":party:");
  await expect(tooltip).toContainText("Fixture Member");
  const tipBox = await tooltip.boundingBox();
  const messageBox = await message.boundingBox();
  const x = Math.max(0, Math.min(tipBox.x, messageBox.x) - 12);
  const y = Math.max(0, Math.min(tipBox.y, messageBox.y) - 12);
  await page.screenshot({
    path: testInfo.outputPath("reaction-preview.png"),
    clip: {
      x,
      y,
      width: Math.min(
        page.viewportSize().width - x,
        Math.max(tipBox.x + tipBox.width, messageBox.x + messageBox.width) -
          x +
          12,
      ),
      height: Math.min(
        page.viewportSize().height - y,
        Math.max(tipBox.y + tipBox.height, messageBox.y + messageBox.height) -
          y +
          12,
      ),
    },
  });
  const heart = row.locator('button[data-reaction="❤️"]');
  await heart.hover();
  await expect(tooltip).toBeVisible({ timeout: 500 });
  await expect(tooltip).toContainText("heart");
  await expect(tooltip).toHaveClass(/reactionPreviewSlideRight/);
  await page.mouse.move(0, 0);
  await custom.hover();
  await expect(tooltip).toHaveCount(0);
  await page.waitForTimeout(300);
  await expect(tooltip).toHaveCount(0);

  await page.evaluate(() => window.emojiFixture.holdNextReaction(":party:"));
  try {
    await custom.click();
    await expect
      .poll(() =>
        page.evaluate(() => window.emojiFixture.report.reactionStarted),
      )
      .toBe(true);
    await expect(custom).toHaveAttribute("aria-pressed", "true");
    await expect(custom).toHaveAttribute("aria-label", /2 people/);
    await expect(native).toHaveAttribute("aria-disabled", "true");
    await expect(custom).toHaveCSS("opacity", "1");
    await expect(custom).toHaveAttribute("aria-disabled", "true");
    await native.evaluate((button) => button.click());
    await expect
      .poll(() => page.evaluate(() => window.emojiFixture.operations()))
      .toBe(1);
  } finally {
    await page.evaluate(() => window.emojiFixture.releaseReaction());
  }
  await expect
    .poll(() =>
      page.evaluate(() => window.emojiFixture.report.publications.length),
    )
    .toBe(1);
  await expect(custom).toHaveAttribute("aria-disabled", "false");
  expect(await order()).toEqual(initialOrder);
  await custom.click();
  await expect(custom).toHaveAttribute("aria-pressed", "false");
  await expect(custom).toHaveAttribute("aria-label", /1 person/);
  await row.locator('button[data-reaction="✅"]').click();
  await expect(row.locator('button[data-reaction="✅"]')).toHaveCount(0);

  await page.setViewportSize({ width: 1280, height: 1100 });
  await page.locator("main").evaluate((element) => {
    element.style.marginTop = "500px";
  });
  await plus.click();
  const picker = page.locator('em-emoji-picker input[type="search"]');
  await expect(picker).toBeVisible();
  const pickerBox = await page.locator('[role="dialog"]').last().boundingBox();
  const plusBox = await plus.boundingBox();
  expect(pickerBox.y + pickerBox.height).toBeLessThan(plusBox.y);
  await picker.fill("aonly");
  await page.getByRole("button", { name: ":aonly:", exact: true }).click();
  await expect(picker).toHaveCount(0);
  await expect(row.locator('button[data-reaction=":aonly:"]')).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await plus.focus();
  await plus.press("Enter");
  await expect(picker).toBeVisible();
  await picker.press("Escape");
  await expect(picker).toHaveCount(0);
  await expect(plus).toBeFocused();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await custom.hover();
  await expect(tooltip).toBeVisible({ timeout: 2500 });
  await expect(tooltip).toHaveCSS("transition-duration", "0s");
});
