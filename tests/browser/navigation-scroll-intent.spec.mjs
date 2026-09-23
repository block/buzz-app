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
  test(`warm sidebar refresh respects ${action} viewport`, async ({
    page,
    app,
  }) => {
    await open(page, app);
    const sidebar = page.getByRole("navigation", {
      name: "Subscribed channels",
    });
    // Save a coherent checkpoint + nonzero position. Hold only the upstream
    // preference refresh: local decoding must remain available on warm restart.
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            new Promise((resolve, reject) => {
              const request = indexedDB.open("buzz-read-models-v1", 1);
              request.onerror = () => reject(request.error);
              request.onsuccess = () => {
                const db = request.result,
                  tx = db.transaction("scopes");
                const get = tx.objectStore("scopes").getAll();
                tx.oncomplete = () => {
                  db.close();
                  resolve(
                    get.result.some(
                      ({ value }) =>
                        value.events.filter((event) => event.kind === 39000)
                          .length > 100,
                    ),
                  );
                };
              };
            }),
        ),
      )
      .toBe(true);
    await sidebar.evaluate((element) => {
      element.scrollTop = 900;
      element.dispatchEvent(new Event("scroll"));
    });
    await button(page, "Home").first().click();
    await expect(sidebar).toHaveCount(0);
    let release;
    const held = new Promise((resolve) => {
      release = resolve;
    });
    let requested = false;
    await page.route("**/api/relay/primary/query", async (route) => {
      const filters = route.request().postDataJSON();
      if (
        !filters.some(
          (filter) =>
            filter.kinds?.includes(30078) &&
            filter["#d"]?.includes("channel-sections"),
        )
      ) {
        await route.continue();
        return;
      }
      requested = true;
      await held;
      await route.continue();
    });
    try {
      await page.reload();
      await button(page, "Messages").first().click();
      await expect
        .poll(() => sidebar.locator("[data-channel-id]").count())
        .toBeGreaterThan(100);
      await expect.poll(() => requested).toBe(true);
      await expect(
        page.getByText("Loading saved groups and stars…", { exact: true }),
      ).toBeHidden();
      expect(await sidebar.evaluate((element) => element.scrollTop)).toBe(900);
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
        await page.mouse.wheel(0, 900);
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
      const refreshed = page.waitForResponse((response) =>
        response.url().endsWith("/sidebar-preferences"),
      );
      release();
      await refreshed;
      await page.evaluate(
        () =>
          new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          ),
      );
      expect(await sidebar.evaluate((element) => element.scrollTop)).toBe(
        action === "untouched" ? 900 : action === "returned to top" ? 0 : 1800,
      );
    } finally {
      release();
      await page.unroute("**/api/relay/primary/query");
    }
  });
}
