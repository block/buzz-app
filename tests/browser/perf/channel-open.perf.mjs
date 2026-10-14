import { test, expect, heads, repeats, sidebar } from "./runner.mjs";

test.use({ historyCounts: { alpha: 1, beta: 120 }, tallMessages: true });
for (const mode of ["cold", "prepared"]) {
  for (let i = 1; i <= repeats; i++) {
    test(`channel-open-${mode} sample ${i}`, async ({ page, app, perf }) => {
      await perf.setup("alpha");
      expect(
        heads(app, "beta"),
        "target has never been opened or prepared",
      ).toBe(0);
      if (mode === "prepared") {
        const head = page.waitForResponse((response) => {
          if (
            !response.url().endsWith("/query") ||
            response.request().method() !== "POST"
          )
            return false;
          return response
            .request()
            .postDataJSON()
            .some(
              (filter) =>
                filter["#h"]?.includes("beta") &&
                filter.top_level &&
                filter.until === undefined,
            );
        });
        await page.locator(sidebar("beta")).hover();
        const response = await head;
        expect(response.ok(), "prepared head response succeeded").toBe(true);
        expect(
          await response.finished(),
          "prepared head body completed",
        ).toBeNull();
        await expect.poll(() => heads(app, "beta")).toBeGreaterThan(0);
        // A completed HTTP response plus a browser idle opportunity lets the
        // prepare continuation consume the head before the measured click.
        await page.evaluate(
          () =>
            new Promise((resolve) =>
              requestIdleCallback(resolve, { timeout: 2000 }),
            ),
        );
      }
      const before = heads(app, "beta");
      const sample = await perf.measure("beta", {
        click: sidebar("beta"),
        work: { mode, headReadsBefore: before },
      });
      sample.work.headReadsDuring = heads(app, "beta") - before;
      await perf.save(sample);
      if (mode === "cold")
        expect(sample.work.headReadsDuring).toBeGreaterThan(0);
      expect(sample.metrics.firstRowsMs).toBeGreaterThan(0);
    });
  }
}
