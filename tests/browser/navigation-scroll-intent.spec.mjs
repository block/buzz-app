import { test, expect } from "./fixture.mjs";
import { open } from "./timeline.mjs";

const button = (page, name) => page.getByRole("button", { name, exact: true });
test.use({
  largeSidebar: true,
  productionBroker: true,
  readState: true,
  historyCounts: { alpha: 1, beta: 1 },
});

for (const action of [
  "untouched",
  "scrolled",
  "returned to top",
  "scroll event pending",
]) {
  test(`delayed sidebar restoration respects ${action} viewport`, async ({
    page,
    app,
  }) => {
    await open(page, app);
    const sidebar = page.getByRole("navigation", {
      name: "Subscribed channels",
    });
    // Save a nonzero position, then cold-load that community with preferences held.
    await sidebar.evaluate((element) => {
      element.scrollTop = 900;
      element.dispatchEvent(new Event("scroll"));
    });
    await button(page, "Personal space").click();
    await expect(button(page, "Personal space")).toHaveAttribute(
      "aria-current",
      "true",
    );
    let release;
    const held = new Promise((resolve) => {
      release = resolve;
    });
    const pendingRoutes = [];
    await page.route("**/api/relay/primary/sidebar-preferences", (route) => {
      const pending = held.then(() => route.continue());
      pendingRoutes.push(pending);
      return pending;
    });
    try {
      await page.reload();
      await button(page, "Switch to Primary").click();
      await expect
        .poll(() => sidebar.locator("[data-channel-id]").count())
        .toBeGreaterThan(100);
      await expect.poll(() => pendingRoutes.length).toBeGreaterThan(0);
      await expect(
        page.getByText("Updating sidebar details…", { exact: true }),
      ).toBeVisible();
      expect(await sidebar.evaluate((element) => element.scrollTop)).toBe(0);
      if (action === "scroll event pending") {
        // Model compositor movement visible before the main-thread scroll
        // callback. The restoration must inspect the current position too.
        await page.evaluate(() => {
          document.addEventListener(
            "scroll",
            (event) => {
              if (
                event.target instanceof HTMLElement &&
                event.target.getAttribute("aria-label") ===
                  "Subscribed channels"
              )
                event.stopImmediatePropagation();
            },
            true,
          );
        });
      }
      if (action !== "untouched") {
        await sidebar.hover({ position: { x: 10, y: 100 } });
        await page.mouse.wheel(0, 1800);
        await expect
          .poll(() => sidebar.evaluate((element) => element.scrollTop))
          .toBe(1800);
      }
      if (action === "returned to top") {
        await page.mouse.wheel(0, -1800);
        await expect
          .poll(() => sidebar.evaluate((element) => element.scrollTop))
          .toBe(0);
      }
      release();
      await expect(
        page.getByText("Updating sidebar details…", { exact: true }),
      ).toBeHidden();
      expect(await sidebar.evaluate((element) => element.scrollTop)).toBe(
        action === "untouched" ? 900 : action === "returned to top" ? 0 : 1800,
      );
    } finally {
      release();
      await Promise.all(pendingRoutes);
      await page.unroute("**/api/relay/primary/sidebar-preferences");
    }
  });
}
