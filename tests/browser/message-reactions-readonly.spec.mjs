import { test, expect } from "./source-fixture.mjs";
import { watchPageErrors } from "./page-errors.mjs";

test.use({ screenshot: "off", trace: "off", video: "on" });

test("stays grouped and stable through a narrow transition", async ({
  page,
}) => {
  const errors = watchPageErrors(page);
  await page.goto("/tests/fixtures/message-gallery.html?group=conversation");
  await page.evaluate(async () => {
    await document.fonts.ready;
  });

  const row = page.locator('[data-message-id="read-only-reactions-main"]');
  const next = page.locator('[data-message-id="read-only-reactions-next"]');
  const reactions = row.locator("[data-message-reactions]");
  const badges = reactions.locator(":scope > [data-reaction]");
  const measureGeometry = () =>
    reactions.evaluate((group) => {
      const frame = group.closest(".message-gallery-frame");
      if (!frame) throw new Error("Missing fixture frame");
      const bounds = group.getBoundingClientRect();
      const frameBounds = frame.getBoundingClientRect();
      const badgeRows = new Set(
        [...group.querySelectorAll(":scope > [data-reaction]")].map((badge) =>
          Math.round(badge.getBoundingClientRect().top),
        ),
      );
      return {
        badgeRows: badgeRows.size,
        contained:
          bounds.left >= frameBounds.left - 1 &&
          bounds.right <= frameBounds.right + 1,
        overflowing: group.scrollWidth > group.clientWidth + 1,
        frameWidth: frameBounds.width,
        bottom: bounds.bottom,
      };
    });

  await expect(reactions).toHaveAttribute("role", "group");
  await expect(reactions).toHaveAccessibleName("Reactions");
  await expect(badges).toHaveCount(10);
  await expect(badges.nth(0)).toHaveAccessibleName("👀: 12 people");
  await expect(badges.nth(0)).toContainText("12");
  await expect(badges.nth(1)).toHaveAccessibleName("👍: 3 people");
  await expect(badges.nth(2)).toHaveAccessibleName("🎉: 4 people");
  await expect(badges.nth(5)).toHaveAccessibleName("✅: 12 people");
  await expect(badges.nth(3)).toHaveAttribute(
    "data-reaction-url",
    "https://fixture.test/media/avatar",
  );
  await expect(badges.nth(4)).toHaveAttribute(
    "data-reaction-url",
    "https://fixture.test/media/party",
  );
  await expect(badges.nth(3).locator('img[alt=":party:"]')).toHaveCount(1);
  await expect(badges.nth(4)).toContainText(":party:");
  await expect(reactions.locator("button, a[href], [tabindex]")).toHaveCount(0);

  const wideGeometry = await measureGeometry();
  const wideNextBounds = await next.boundingBox();
  if (!wideNextBounds) throw new Error("Missing next message geometry");
  expect(wideGeometry.badgeRows).toBe(1);
  expect(wideGeometry.contained).toBe(true);
  expect(wideGeometry.overflowing).toBe(false);
  expect(wideNextBounds.y).toBeGreaterThanOrEqual(wideGeometry.bottom);

  await page.getByRole("button", { name: "Narrow preview" }).click();
  await expect(page.locator(".message-gallery-examples")).toHaveAttribute(
    "data-narrow",
    "true",
  );
  await page.setViewportSize({ width: 360, height: 950 });
  const narrowGeometry = await measureGeometry();
  const narrowNextBounds = await next.boundingBox();
  if (!narrowNextBounds) throw new Error("Missing next message geometry");
  expect(narrowGeometry.frameWidth).toBeLessThan(wideGeometry.frameWidth);
  expect(narrowGeometry.badgeRows).toBeGreaterThan(wideGeometry.badgeRows);
  expect(narrowGeometry.badgeRows).toBeLessThanOrEqual(4);
  expect(narrowGeometry.contained).toBe(true);
  expect(narrowGeometry.overflowing).toBe(false);
  expect(narrowNextBounds.y).toBeGreaterThanOrEqual(narrowGeometry.bottom);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);

  await page.setViewportSize({ width: 1440, height: 950 });
  await page.getByRole("button", { name: "Narrow preview" }).click();
  await expect(page.locator(".message-gallery-examples")).not.toHaveAttribute(
    "data-narrow",
    "true",
  );
  const restoredGeometry = await measureGeometry();
  const restoredNextBounds = await next.boundingBox();
  if (!restoredNextBounds) throw new Error("Missing next message geometry");
  expect(restoredGeometry.frameWidth).toBeCloseTo(wideGeometry.frameWidth, 1);
  expect(restoredGeometry.badgeRows).toBe(wideGeometry.badgeRows);
  expect(restoredNextBounds.x).toBeCloseTo(wideNextBounds.x, 1);
  expect(restoredNextBounds.y).toBeCloseTo(wideNextBounds.y, 1);
  expect(restoredNextBounds.width).toBeCloseTo(wideNextBounds.width, 1);
  expect(restoredNextBounds.height).toBeCloseTo(wideNextBounds.height, 1);

  await page.getByRole("button", { name: "Reset examples" }).click();
  const resetNextBounds = await next.boundingBox();
  if (!resetNextBounds) throw new Error("Missing next message geometry");
  expect(resetNextBounds.x).toBeCloseTo(wideNextBounds.x, 1);
  expect(resetNextBounds.y).toBeCloseTo(wideNextBounds.y, 1);
  expect(resetNextBounds.width).toBeCloseTo(wideNextBounds.width, 1);
  expect(resetNextBounds.height).toBeCloseTo(wideNextBounds.height, 1);
  expect(errors.unexplained()).toEqual([]);
});
