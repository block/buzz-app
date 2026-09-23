import { test, expect } from "./fixture.mjs";
import { open } from "./timeline.mjs";

test.use({ productionBroker: true, savedSidebar: true, dmLabels: true });

// Browser-only contract: real IndexedDB survives reload, and one viewport DOM
// survives preconnection -> authorized rendering through the production broker.
test("warm restart paints saved groups before session discovery and retains the viewport", async ({
  page,
  app,
}) => {
  await open(page, app);
  const sidebar = page.getByRole("navigation", { name: "Subscribed channels" });
  await expect(sidebar.locator("summary", { hasText: /^Work$/ })).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          new Promise((resolve, reject) => {
            const request = indexedDB.open("buzz-read-models-v1", 1);
            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
              const db = request.result;
              const tx = db.transaction("scopes");
              const get = tx.objectStore("scopes").getAll();
              tx.oncomplete = () => {
                db.close();
                resolve(
                  get.result.some((value) =>
                    value.value.events.some((event) => event.kind === 39000),
                  ),
                );
              };
            };
          }),
      ),
    )
    .toBe(true);
  await expect(sidebar.locator('button[data-channel-id="dm-peer"]')).toHaveText(
    "Alice Fixture",
  );
  const held = Promise.withResolvers();
  const started = Promise.withResolvers();
  const metadataHeld = Promise.withResolvers();
  const metadataStarted = Promise.withResolvers();
  const metadataFinished = Promise.withResolvers();
  await page.route("**/api/relay/primary/query", async (route) => {
    if (
      route
        .request()
        .postDataJSON()
        .some((filter) => filter.kinds?.includes(39000))
    ) {
      metadataStarted.resolve();
      await metadataHeld.promise;
      await route.continue();
      metadataFinished.resolve();
    } else await route.continue();
  });
  await page.route("**/session", async (route) => {
    started.resolve();
    await held.promise;
    await route.continue();
  });
  try {
    await page.reload();
    await started.promise;
    await page
      .getByRole("button", { name: "Messages", exact: true })
      .first()
      .click();
    await expect(
      sidebar.locator("summary", { hasText: /^Work$/ }),
    ).toBeVisible();
    await expect(sidebar.locator('button[data-channel-id="beta"]')).toHaveText(
      "Beta",
    );
    await expect(
      sidebar.locator('button[data-channel-id="beta"]'),
    ).toBeDisabled();
    await expect(page.getByRole("textbox", { name: /Message #/ })).toHaveCount(
      0,
    );
    await sidebar.evaluate((element) => {
      window.restoredSidebar = element;
    });
    held.resolve();
    await metadataStarted.promise;
    await expect(
      sidebar.locator('button[data-channel-id="dm-peer"]'),
    ).toHaveText("Alice Fixture");
    await expect(
      sidebar
        .locator('button[data-channel-id="dm-peer"]')
        .locator("xpath=ancestor::details[1]/summary"),
    ).toHaveText("DMs");
    await expect(
      sidebar.locator('button[data-channel-id="beta"]'),
    ).toBeEnabled();
    expect(
      await sidebar.evaluate((element) => element === window.restoredSidebar),
    ).toBe(true);
    await expect(
      sidebar.locator("summary", { hasText: /^Work$/ }),
    ).toBeVisible();
    metadataHeld.resolve();
    await metadataFinished.promise;
    await sidebar.locator('button[data-channel-id="beta"]').click();
    await expect(
      page.getByRole("textbox", { name: "Message #Beta", exact: true }),
    ).toBeVisible();
  } finally {
    held.resolve();
    metadataHeld.resolve();
    await page.unroute("**/session");
    await page.unroute("**/api/relay/primary/query");
  }
});

// Real app startup wiring: either optional result may finish first. Neither
// ordering may paint IDs or default groups before the coherent cold sidebar.
for (const first of ["metadata", "preferences"]) {
  test(`cold startup waits for coherent labels/groups with ${first} first`, async ({
    page,
    app,
  }) => {
    const gates = Object.fromEntries(
      ["metadata", "preferences"].map((key) => [
        key,
        {
          started: Promise.withResolvers(),
          release: Promise.withResolvers(),
        },
      ]),
    );
    const isMetadata = (request) =>
      request.url().endsWith("/api/relay/primary/query") &&
      request.postDataJSON().some((filter) => filter.kinds?.includes(39000));
    const isPreferences = (request) =>
      request.url().endsWith("/sidebar-preferences");
    const intercept = async (route) => {
      const key = isMetadata(route.request())
        ? "metadata"
        : isPreferences(route.request())
          ? "preferences"
          : undefined;
      if (key) {
        gates[key].started.resolve();
        await gates[key].release.promise;
      }
      await route.continue();
    };
    await page.route("**/api/relay/primary/query", intercept);
    await page.route("**/sidebar-preferences", intercept);
    try {
      await page.goto(app.origin);
      await page
        .getByRole("button", { name: "Messages", exact: true })
        .first()
        .click();
      await Promise.all(
        Object.values(gates).map((gate) => gate.started.promise),
      );
      const sidebar = page.getByRole("navigation", {
        name: "Subscribed channels",
      });
      await expect(sidebar.locator("[data-channel-id]")).toHaveCount(0);
      const response = page.waitForResponse((response) =>
        (first === "metadata" ? isMetadata : isPreferences)(response.request()),
      );
      gates[first].release.resolve();
      await response;
      // Drain the render triggered by the released result while its counterpart
      // remains explicitly held; assert the pending render contains no fallback rows.
      await page.evaluate(
        () =>
          new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          ),
      );
      await expect(sidebar.locator("[data-channel-id]")).toHaveCount(0);
      gates[
        first === "metadata" ? "preferences" : "metadata"
      ].release.resolve();
      await expect(
        sidebar.locator("summary", { hasText: /^Work$/ }),
      ).toBeVisible();
      await expect(
        sidebar.locator('button[data-channel-id="beta"]'),
      ).toHaveText("Beta");
      await expect(
        sidebar.locator('button[data-channel-id="dm-peer"]'),
      ).toHaveText("Alice Fixture");
    } finally {
      for (const gate of Object.values(gates)) gate.release.resolve();
      await page.unroute("**/api/relay/primary/query");
      await page.unroute("**/sidebar-preferences");
    }
  });
}
