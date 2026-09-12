import { readFile } from "node:fs/promises";
import { test, expect } from "./fixture.mjs";
import { open } from "./timeline.mjs";

test.use({ productionBroker: true, largeSidebar: true, openingProbe: true });
const heads = (app, channel) =>
  app.report.queries.filter(
    ({ filter }) =>
      filter.kinds?.includes(9) &&
      filter.top_level === true &&
      filter["#h"]?.includes(channel) &&
      filter.until === undefined,
  );

// HTTP completion and visible retained rows are insufficient: the client must
// have verified and applied each authoritative head before the warm baseline.
const warmWindows = (page) =>
  page.waitForFunction(() =>
    ["alpha", "beta"].every((id) => {
      const state = window.openingProbe?.window(id);
      return state?.status === "ready" && state.freshness === "verified";
    }),
  );

// Runs before the app fixture writes/attaches its evidence and closes the page,
// including assertion failures. Same supported snapshot as Export timings, with
// no navigation to Messages (which could itself submit reads) during cleanup.
test.afterEach(async ({ page, app }, testInfo) => {
  try {
    const evidence = await page.evaluate(() => ({
      browserTimeOrigin: performance.timeOrigin,
      relayTimings: window.openingProbe?.timings(),
      openingSamples: window.openingSamples ?? [],
      finalWindows: ["alpha", "beta"].map((channel) => ({
        channel,
        ...window.openingProbe?.window(channel),
      })),
    }));
    Object.assign(app.report, evidence);
    if (!evidence.relayTimings) throw new Error("Opening probe unavailable");
  } catch (error) {
    app.report.openingExportError = String(error);
    // Preserve the original failure; a missing export on a pass still fails.
    if (!testInfo.errors.length) throw error;
  }
});

const isHead = (filter) =>
  filter.kinds?.includes(9) &&
  filter.top_level === true &&
  filter.until === undefined;

function recordHeads(page, app) {
  const requests = new Map();
  const submitted = [];
  app.report.submittedHeads = submitted;
  page.on("request", (request) => {
    if (!new URL(request.url()).pathname.endsWith("/query")) return;
    const filters = request.postDataJSON()?.filter(isHead) ?? [];
    if (!filters.length) return;
    const record = { filters, at: performance.now(), state: "submitted" };
    submitted.push(record);
    requests.set(request, record);
  });
  page.on("requestfinished", (request) => {
    const record = requests.get(request);
    if (record)
      Object.assign(record, { state: "finished", timing: request.timing() });
  });
  page.on("requestfailed", (request) => {
    const record = requests.get(request);
    if (record)
      Object.assign(record, {
        state: "failed",
        timing: request.timing(),
        failure: request.failure(),
      });
  });
  return submitted;
}

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

for (const { surface, heldAlpha } of [
  { surface: "Messages" },
  { surface: "Pulse" },
  { surface: "Pulse", heldAlpha: true },
]) {
  test(`${surface} comparable cold and warm channel opening with shared production broker${heldAlpha ? "; retained rows cannot warm a held first Alpha head" : ""}`, async ({
    page,
    app,
  }) => {
    const submitted = recordHeads(page, app);
    let releaseAlpha;
    if (heldAlpha) {
      const released = new Promise((resolve) => {
        releaseAlpha = resolve;
      });
      await page.route("**/api/relay/primary/query", async (route) => {
        if (
          route
            .request()
            .postDataJSON()
            ?.some((filter) => isHead(filter) && filter["#h"]?.[0] === "alpha")
        )
          await released;
        await route.continue();
      });
    }
    try {
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
            const sample = { name, start, frames: [], outcome: "pending" };
            window.openingSamples ??= [];
            window.openingSamples.push(sample);
            button.click();
            sample.clickSyncMs = performance.now() - start;
            await new Promise((resolve, reject) => {
              const deadline = setTimeout(() => {
                sample.outcome = "timeout";
                reject(new Error("opening did not paint"));
              }, 10000);
              const check = () => {
                if (sample.outcome !== "pending") return;
                const checkStart = performance.now();
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
                sample.frames.push({
                  atMs: checkStart - start,
                  checkMs: performance.now() - checkStart,
                  visible: !!visible,
                  composer: !!composer,
                });
                if (!composer || !visible) return requestAnimationFrame(check);
                sample.rowVisibleMs = performance.now() - start;
                requestAnimationFrame(() => {
                  clearTimeout(deadline);
                  sample.visibleMs = performance.now() - start;
                  sample.outcome = "paint-opportunity";
                  resolve();
                });
              };
              requestAnimationFrame(check);
            });
            return { ...sample };
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
            ?.some(
              (filter) => filter.top_level && filter["#h"]?.[0] === "beta",
            ),
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
      // Messages opens Alpha during startup (including live catch-up). Capture
      // that preexisting work only after it is authoritative; the explicit
      // revisit below must reuse it. Pulse has not opened Alpha at all yet.
      let messagesAlpha;
      const alphaCounts = () => ({
        submitted: submitted.filter(({ filters }) =>
          filters.some((f) => f["#h"]?.[0] === "alpha"),
        ).length,
        admitted: heads(app, "alpha").length,
      });
      if (surface === "Messages") {
        await warmWindows(page);
        messagesAlpha = alphaCounts();
        app.report.messagesStartupAlpha = messagesAlpha;
      }
      await measure("Alpha");
      if (heldAlpha) {
        await expect
          .poll(
            () =>
              submitted.filter(({ filters }) =>
                filters.some((f) => f["#h"]?.[0] === "alpha"),
              ).length,
          )
          .toBe(1);
        const state = await page.evaluate(() =>
          window.openingProbe.window("alpha"),
        );
        expect(state.rows).toBeGreaterThan(0);
        expect(state.status).toBe("loading");
        expect(state.freshness).not.toBe("verified");
        expect(heads(app, "alpha")).toHaveLength(0);
        // This is exactly the old early baseline: rows painted, first submission
        // outstanding, only Beta admitted. Release only after proving the race.
        app.report.heldAlpha = {
          state,
          submissions: submitted.length,
          admissions: app.report.queries.filter(({ filter }) => isHead(filter))
            .length,
        };
        releaseAlpha();
      }
      await warmWindows(page);
      expect(heads(app, "beta")).toHaveLength(1);
      if (surface === "Messages") expect(alphaCounts()).toEqual(messagesAlpha);
      else expect(heads(app, "alpha")).toHaveLength(1);
      for (const channel of ["alpha", "beta"]) {
        const channelHeads = submitted.filter(({ filters }) =>
          filters.some((f) => f["#h"]?.[0] === channel),
        );
        expect(
          channelHeads.filter((request) => request.state === "submitted"),
        ).toHaveLength(0);
        if (surface === "Messages" && channel === "alpha") continue;
        // Require exactly one completed cold head, separately accounting for
        // at most one navigation-aborted fetch that never reached upstream.
        expect(
          channelHeads.filter((request) => request.state === "finished"),
        ).toHaveLength(1);
        const failed = channelHeads.filter(
          (request) => request.state === "failed",
        );
        expect(failed.length).toBeLessThanOrEqual(1);
        for (const request of failed)
          expect(request.failure.errorText).toMatch(/abort|cancel/i);
      }
      const before = {
        submitted: submitted.length,
        admitted: heads(app, "beta").length + heads(app, "alpha").length,
      };
      app.report.warmBaseline = before;
      for (const name of ["Beta", "Alpha", "Beta", "Alpha"]) {
        const sample = await measure(name);
        const { visibleMs } = sample;
        app.report.measurements.push({
          surface,
          state: "warm",
          channel: name,
          ...sample,
        });
        expect.soft(visibleMs).toBeLessThan(100);
      }
      expect(heads(app, "beta").length + heads(app, "alpha").length).toBe(
        before.admitted,
      );
      expect(submitted).toHaveLength(before.submitted);
    } finally {
      releaseAlpha?.();
    }
  });
}
