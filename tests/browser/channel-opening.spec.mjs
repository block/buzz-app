import { readFile } from "node:fs/promises";
import { test, expect } from "./fixture.mjs";
import { open } from "./timeline.mjs";

test.use({ productionBroker: true, largeSidebar: true });
const heads = (app, channel) =>
  app.report.queries.filter(
    ({ filter }) =>
      filter.kinds?.includes(9) &&
      filter.top_level === true &&
      filter["#h"]?.includes(channel) &&
      filter.until === undefined,
  );

test("cold opening bypasses held DM labels; warm switching paints within 100ms without a head read", {
  tag: "@local-webkit",
}, async ({ page, app }) => {
  const submittedHeads = [];
  page.on("request", (request) => {
    if (!new URL(request.url()).pathname.endsWith("/query")) return;
    for (const filter of request.postDataJSON() ?? [])
      if (
        filter.kinds?.includes(9) &&
        filter.top_level === true &&
        filter.until === undefined
      )
        submittedHeads.push(filter);
  });
  const labelReads = () =>
    app.report.queries.filter(
      ({ filter }) =>
        filter.kinds?.includes(0) &&
        filter.authors?.some((id) => app.participants.includes(id)),
    );
  app.relay.holdProfiles(app.participants);
  try {
    await open(page, app);
    await expect.poll(() => labelReads().length).toBe(1);
    expect(labelReads()[0].filter.authors).toHaveLength(500);
    // The actual label hook has >1,000 missing participants. Keep its profile
    // response held through cold opening; do not bypass that production caller.
    expect(heads(app, "beta")).toHaveLength(0);
    await page
      .getByRole("button", { name: "Beta", exact: true })
      .evaluate((button) => {
        performance.mark("cold-beta-click");
        button.click();
      });
    await expect(
      page.getByRole("textbox", { name: "Message #Beta", exact: true }),
    ).toBeVisible();
    await expect(page.locator("[data-message-id]").first()).toBeVisible();
    app.report.measurements.push({
      name: "Beta",
      coldVisibleUpperBoundMs: await page.evaluate(
        () =>
          performance.now() -
          performance.getEntriesByName("cold-beta-click").at(-1).startTime,
      ),
      note: "Includes Playwright visibility assertion roundtrip; warm times use browser paint clock",
    });
    expect(heads(app, "beta").length).toBeGreaterThan(0);
    expect(app.report.profileHolds.some((held) => held.pending)).toBe(true);
    expect(app.report.profileHolds.some((held) => held.aborted)).toBe(false);
    const before = submittedHeads.length;
    // Browser-clock click → first visible row → paint, excluding Playwright IPC.
    for (const name of ["Alpha", "Beta", "Alpha", "Beta"]) {
      const visibleMs = await page
        .getByRole("button", { name, exact: true })
        .evaluate(
          async (button, { name, ids }) => {
            const start = performance.now();
            button.click();
            await new Promise((resolve, reject) => {
              const deadline = setTimeout(
                () => reject(new Error("warm switch did not paint")),
                1000,
              );
              const check = () => {
                const composer = document.querySelector(
                  `textarea[placeholder="Message #${name}"]`,
                );
                const history = document.querySelector(
                  '[aria-label="Channel message history"]',
                );
                const rect = history?.getBoundingClientRect();
                const visible =
                  rect &&
                  [...history.querySelectorAll("[data-message-id]")].some(
                    (row) => {
                      const bounds = row.getBoundingClientRect();
                      return (
                        ids.includes(row.dataset.messageId) &&
                        bounds.height > 0 &&
                        bounds.bottom > rect.top &&
                        bounds.top < rect.bottom
                      );
                    },
                  );
                if (!visible || !composer) return requestAnimationFrame(check);
                requestAnimationFrame(() => {
                  clearTimeout(deadline);
                  resolve();
                });
              };
              requestAnimationFrame(check);
            });
            return performance.now() - start;
          },
          {
            name,
            ids: app.histories
              .get(`primary/${name.toLowerCase()}`)
              .map((event) => event.id),
          },
        );
      app.report.measurements.push({ name, warmVisibleMs: visibleMs });
      expect(visibleMs).toBeLessThan(100);
    }
    expect(submittedHeads).toHaveLength(before);
    const diagnostics = page
      .locator("summary")
      .filter({ hasText: /^Relay timings$/ });
    await diagnostics.evaluate((element) => {
      for (
        let parent = element.parentElement;
        parent;
        parent = parent.parentElement
      )
        if (parent.tagName === "DETAILS") parent.open = true;
    });
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "Export timings" }).click();
    const timings = await download;
    app.report.relayTimings = JSON.parse(
      await readFile(await timings.path(), "utf8"),
    );
    expect(app.report.profileHolds.some((held) => held.pending)).toBe(true);
    expect(app.report.profileHolds.some((held) => held.aborted)).toBe(false);
  } finally {
    app.relay.releaseProfiles();
  }
});

for (const surface of ["Messages", "Pulse"]) {
  test(`${surface} comparable cold and warm channel opening with shared production broker`, async ({
    page,
    app,
  }) => {
    await page.goto(app.origin);
    await page
      .getByRole("navigation", { name: "Pages", exact: true })
      .getByRole("button", { name: surface, exact: true })
      .click();
    const rail =
      surface === "Pulse"
        ? page.getByRole("navigation", { name: "Pulse conversations" })
        : page;
    const button = (name) => rail.getByRole("button", { name, exact: true });
    await expect(button("Beta")).toBeVisible();
    await expect(
      surface === "Pulse"
        ? page.getByRole("article").first()
        : page
            .getByRole("region", { name: "Channel message history" })
            .locator("[data-message-id]")
            .first(),
    ).toBeVisible();
    // Equivalent unprepared Beta: no hover/focus, empty authoritative window.
    expect(heads(app, "beta")).toHaveLength(0);
    const measure = async (name) =>
      button(name).evaluate(
        async (button, { name, ids }) => {
          const start = performance.now();
          button.click();
          await new Promise((resolve, reject) => {
            const deadline = setTimeout(
              () => reject(new Error("opening did not paint")),
              10000,
            );
            const check = () => {
              const history = document.querySelector(
                '[aria-label="Channel message history"]',
              );
              const composer = document.querySelector(
                `textarea[placeholder="Message #${name}"]`,
              );
              const rect = history?.getBoundingClientRect();
              const visible =
                rect &&
                [...history.querySelectorAll("[data-message-id]")].some(
                  (row) => {
                    const bounds = row.getBoundingClientRect();
                    return (
                      ids.includes(row.dataset.messageId) &&
                      bounds.height > 0 &&
                      bounds.bottom > rect.top &&
                      bounds.top < rect.bottom
                    );
                  },
                );
              if (!composer || !visible) return requestAnimationFrame(check);
              requestAnimationFrame(() => {
                clearTimeout(deadline);
                resolve();
              });
            };
            requestAnimationFrame(check);
          });
          return { start, visibleMs: performance.now() - start };
        },
        {
          name,
          ids: app.histories
            .get(`primary/${name.toLowerCase()}`)
            .map((event) => event.id),
        },
      );
    const coldResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith("/query") &&
        response
          .request()
          .postDataJSON()
          ?.some((filter) => filter.top_level && filter["#h"]?.[0] === "beta"),
    );
    const cold = await measure("Beta");
    const response = await coldResponse;
    await response.finished();
    app.report.coldRequest = {
      timeOrigin: await page.evaluate(() => performance.timeOrigin),
      timing: response.request().timing(),
      serverTiming: response.headers()["server-timing"],
    };
    app.report.measurements.push({
      surface,
      state: "cold-unprepared",
      channel: "Beta",
      ...cold,
    });
    expect(heads(app, "beta")).toHaveLength(1);
    await measure("Alpha");
    const before = heads(app, "beta").length + heads(app, "alpha").length;
    for (const name of ["Beta", "Alpha", "Beta", "Alpha"]) {
      const { visibleMs } = await measure(name);
      app.report.measurements.push({
        surface,
        state: "warm",
        channel: name,
        visibleMs,
      });
      expect(visibleMs).toBeLessThan(100);
    }
    expect(heads(app, "beta").length + heads(app, "alpha").length).toBe(before);
    // The diagnostics control belongs to Messages, but exports this same session.
    if (surface === "Pulse")
      await page
        .getByRole("navigation", { name: "Pages", exact: true })
        .getByRole("button", { name: "Messages", exact: true })
        .click();
    const diagnostics = page
      .locator("summary")
      .filter({ hasText: /^Relay timings$/ });
    await diagnostics.evaluate((el) => {
      for (let p = el.parentElement; p; p = p.parentElement)
        if (p.tagName === "DETAILS") p.open = true;
    });
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "Export timings" }).click();
    app.report.relayTimings = JSON.parse(
      await readFile(await (await download).path(), "utf8"),
    );
  });
}
