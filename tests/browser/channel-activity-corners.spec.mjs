import { test, expect } from "./fixture.mjs";
import { open } from "./timeline.mjs";

// Browser geometry is the contract: jsdom cannot show a rounded overflow clip.
// Keep the real channel hover, rows and popup; only the upstream relay is modeled.
test.use({
  productionBroker: true,
  readState: true,
  threadUnread: true,
  historyCounts: { alpha: 2, beta: 1 },
});

for (const multiple of [false, true]) {
  test.describe(multiple ? "multiple rows" : "single row", () => {
    test.use({ threadUnreadMentions: multiple });

    test("channel activity corners preserve the popup inset", async ({
      page,
      app,
    }, testInfo) => {
      await open(page, app);
      const alpha = page.locator('button[data-channel-id="alpha"]');
      await expect(
        alpha.getByRole("img", { name: /unread threads?/ }),
      ).toBeVisible();
      await alpha.hover();
      const popup = page.getByRole("dialog", { name: "Activity in Alpha" });
      const rows = popup.getByRole("button", {
        name: /Open unread thread from/,
      });
      await expect(rows).toHaveCount(multiple ? 2 : 1);
      await rows.first().hover();
      await expect(popup).not.toHaveAttribute("data-starting-style", "");
      for (const mode of ["light", "dark"]) {
        await page.evaluate((mode) => {
          document.documentElement.dataset.colorMode = mode;
        }, mode);
        // Include the narrow popup and enlarged text without changing its content.
        for (const width of [1440, 640]) {
          await page.setViewportSize({ width, height: 950 });
          await page.evaluate((width) => {
            document.documentElement.style.setProperty(
              "--type-scale",
              width === 640 ? "2" : "1",
            );
          }, width);
          await expect
            .poll(
              () =>
                popup.evaluate((element) => {
                  const style = getComputedStyle(element);
                  const outerRadius = parseFloat(style.borderTopLeftRadius);
                  const expected =
                    outerRadius -
                    parseFloat(style.borderTopWidth) -
                    parseFloat(style.paddingTop);
                  return Array.from(
                    element.querySelectorAll(".navigation-item"),
                  ).every((row) => {
                    const inner = getComputedStyle(row);
                    return [
                      inner.borderTopLeftRadius,
                      inner.borderTopRightRadius,
                      inner.borderBottomLeftRadius,
                      inner.borderBottomRightRadius,
                    ].every(
                      (radius) => Math.abs(parseFloat(radius) - expected) < 0.1,
                    );
                  });
                }),
              { message: "each row follows the popup's inset corner curve" },
            )
            .toBe(true);
          await expect(rows.last()).toBeVisible();
          await rows.last().hover();
          await expect(rows.last().locator("..")).toHaveCSS(
            "border-top-width",
            "0px",
          );
          await popup.screenshot({
            path: testInfo.outputPath(`hover-corners-${mode}-${width}.png`),
          });
        }
      }
      // A short viewport makes this same real popover scroll, without replacing
      // its rows or disabling clipping to make the corner assertion pass.
      await page.setViewportSize({ width: 640, height: 240 });
      await rows.last().scrollIntoViewIfNeeded();
      await rows.last().hover();
      await expect(rows.last()).toBeInViewport();
      await popup.screenshot({
        path: testInfo.outputPath("hover-corners-scrolled.png"),
      });
      await page.setViewportSize({ width: 640, height: 950 });
      await rows.last().focus();
      await expect(rows.last()).toBeFocused();
      await rows.last().press("Enter");
      await expect(
        page.getByRole("complementary", { name: "Thread", exact: true }),
      ).toBeVisible();
      await expect(popup).toHaveCount(0);
    });
  });
}
