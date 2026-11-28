import { test, expect } from "./source-fixture.mjs";
import { watchPageErrors } from "./page-errors.mjs";

test.use({ screenshot: "off", trace: "off", video: "on" });

test("keeps read-only reaction badges and counts visible without overlapping the next message", async ({
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
  const longShortcode =
    ":celebrating_the_quarterly_release_readiness_milestone_together_:";

  const measureLayout = () =>
    reactions.evaluate((group) => {
      const frame = group.closest(".message-gallery-frame");
      if (!frame) throw new Error("Missing fixture frame");
      const bounds = group.getBoundingClientRect();
      const frameBounds = frame.getBoundingClientRect();
      const items = [...group.querySelectorAll(":scope > [data-reaction]")];
      const badgeRows = new Set(
        items.map((badge) => Math.round(badge.getBoundingClientRect().top)),
      );
      const badgeMetrics = items.map((badge) => {
        const badgeBounds = badge.getBoundingClientRect();
        const countEl = badge.querySelector("span > span:last-child");
        const countBounds = countEl?.getBoundingClientRect();
        return {
          reaction: badge.getAttribute("data-reaction"),
          badgeContained:
            badgeBounds.width > 0 &&
            badgeBounds.height > 0 &&
            badgeBounds.left >= frameBounds.left - 1 &&
            badgeBounds.right <= frameBounds.right + 1,
          countVisible:
            !!countBounds &&
            countBounds.width > 0 &&
            countBounds.height > 0 &&
            countBounds.left >= badgeBounds.left - 1 &&
            countBounds.right <= badgeBounds.right + 1 &&
            countBounds.right <= frameBounds.right + 1,
        };
      });
      return {
        badgeRows: badgeRows.size,
        contained:
          bounds.left >= frameBounds.left - 1 &&
          bounds.right <= frameBounds.right + 1,
        overflowing: group.scrollWidth > group.clientWidth + 1,
        frameWidth: frameBounds.width,
        bottom: bounds.bottom,
        allBadgesContained: badgeMetrics.every((m) => m.badgeContained),
        allCountsVisible: badgeMetrics.every((m) => m.countVisible),
        badgeMetrics,
      };
    });

  await expect(badges).toHaveCount(11);
  const longBadge = reactions.locator(
    `:scope > [data-reaction="${longShortcode}"]`,
  );
  await expect(longBadge).toHaveAccessibleName(`${longShortcode}: 5 people`);
  await expect(longBadge).toContainText("5");

  const wideLayout = await measureLayout();
  const wideNextBounds = await next.boundingBox();
  if (!wideNextBounds) throw new Error("Missing next message geometry");
  expect(wideLayout.contained).toBe(true);
  expect(wideLayout.overflowing).toBe(false);
  expect(wideLayout.allBadgesContained).toBe(true);
  expect(wideLayout.allCountsVisible).toBe(true);
  expect(wideNextBounds.y).toBeGreaterThanOrEqual(wideLayout.bottom);

  await page.getByRole("button", { name: "Narrow preview" }).click();
  await expect(page.locator(".message-gallery-examples")).toHaveAttribute(
    "data-narrow",
    "true",
  );
  await page.setViewportSize({ width: 360, height: 950 });

  const narrowLayout = await measureLayout();
  const narrowNextBounds = await next.boundingBox();
  if (!narrowNextBounds) throw new Error("Missing next message geometry");
  expect(narrowLayout.frameWidth).toBeLessThan(wideLayout.frameWidth);
  expect(narrowLayout.badgeRows).toBeGreaterThan(wideLayout.badgeRows);
  expect(narrowLayout.contained).toBe(true);
  expect(narrowLayout.overflowing).toBe(false);
  expect(narrowLayout.allBadgesContained).toBe(true);
  expect(narrowLayout.allCountsVisible).toBe(true);
  expect(narrowNextBounds.y).toBeGreaterThanOrEqual(narrowLayout.bottom);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  expect(errors.unexplained()).toEqual([]);
});
