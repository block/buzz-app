import { animationsSettled } from "./animations.mjs";
import { test, expect } from "./fixture.mjs";

test.use({
  productionBroker: true,
  readState: true,
  enabledPlugins: ["buzz.reminders", "buzz.workflows"],
});

// Browser-only: real shell slots and page scrollports must share the same bounds.
// Drafts & sent is a Team list now, so it has no page column of its own.
test("primary destinations keep their headers and bodies in one column", async ({
  page,
  app,
}, testInfo) => {
  await page.goto(app.origin);
  for (const [width, mode, scale] of [
    [1920, "light", 100],
    [760, "dark", 100],
    [480, "light", 125],
  ]) {
    await page.setViewportSize({ width, height: 950 });
    await page.emulateMedia({ colorScheme: mode });
    await page.evaluate((value) => {
      document.documentElement.style.fontSize = `${value}%`;
    }, scale);
    let reference;
    for (const [title, pluginId, pageId] of [
      ["Reminders", "buzz.reminders", "reminders"],
      ["Workflows", "buzz.workflows", "workflows"],
    ]) {
      await page.evaluate(
        (target) => {
          location.hash = `buzz=${encodeURIComponent(JSON.stringify(target))}`;
        },
        { version: 1, kind: "page", pluginId, pageId },
      );
      const heading = page
        .getByRole("heading", { name: title, exact: true })
        .first();
      await expect(heading).toBeVisible();
      // A page slides in beside the rail; measure it at rest.
      await animationsSettled(page.locator("body"), { subtree: true });
      const bounds = await heading.evaluate((el) => {
        const header = el.closest("header, .buzz-content-header");
        const rect = header.getBoundingClientRect();
        return { x: rect.x, width: rect.width };
      });
      reference ??= bounds;
      expect(bounds.x).toBeCloseTo(reference.x, 0);
      expect(bounds.width).toBeCloseTo(reference.width, 0);
      expect(bounds.width).toBeLessThanOrEqual(width);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBe(width);
      if (title === "Reminders") {
        // Browser host has no native reminder store; inspect its real status body.
        const empty = page.getByText(
          "Connect to a community to see your reminders.",
          { exact: true },
        );
        await expect(empty).toBeVisible();
        const emptyBox = await empty.boundingBox();
        expect(emptyBox.x).toBeGreaterThanOrEqual(bounds.x);
        expect(emptyBox.x + emptyBox.width).toBeLessThanOrEqual(
          bounds.x + bounds.width,
        );
      }
      await page.screenshot({
        path: testInfo.outputPath(
          `${title.replaceAll(/[^a-z]/gi, "-")}-${width}-${mode}.png`,
        ),
      });
    }
  }
});
