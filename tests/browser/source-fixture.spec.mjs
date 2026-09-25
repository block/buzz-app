import { test, expect } from "./source-fixture.mjs";

let starts = 0;
let origin;
test.use({
  sourcePlugins: [
    {
      name: "source-fixture-lifecycle-control",
      // This control serves only HTML, not the app's optimizable imports.
      config: () => ({ optimizeDeps: { noDiscovery: true, include: [] } }),
      configureServer(server) {
        starts++;
        server.middlewares.use("/__source-fixture", (_req, res) => {
          res.setHeader("Content-Type", "text/html");
          res.end("<p>Shared stateless fixture</p>");
        });
      },
    },
  ],
});
test.beforeAll(async ({ sourceOrigin }) => {
  origin = sourceOrigin;
});

// Real Playwright worker reuse must not reuse browser storage between tests.
for (const visit of [1, 2]) {
  test(`shared source server keeps browser state isolated on visit ${visit}`, async ({
    page,
    sourceOrigin,
  }) => {
    expect(starts).toBe(1);
    expect(sourceOrigin).toBe(origin);
    await page.goto("/__source-fixture");
    await expect(page.getByText("Shared stateless fixture")).toBeVisible();
    expect(
      await page.evaluate(() => localStorage.getItem("previous-test")),
    ).toBeNull();
    expect(await page.context().cookies()).toEqual([]);
    await page.evaluate(() => localStorage.setItem("previous-test", "present"));
    await page
      .context()
      .addCookies([
        { name: "previous-test", value: "present", url: sourceOrigin },
      ]);
    expect(
      await page.evaluate(() => localStorage.getItem("previous-test")),
    ).toBe("present");
    expect(await page.context().cookies()).toHaveLength(1);
  });
}
