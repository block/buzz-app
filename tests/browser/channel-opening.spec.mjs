import { openChannelDetails } from "./channel-details.mjs";
import { readFile } from "node:fs/promises";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { test, expect } from "./fixture.mjs";
import { open } from "./timeline.mjs";

test.use({
  productionBroker: true,
  largeSidebar: true,
  historyCounts: { alpha: 20, beta: 20 },
});
const heads = (app, channel) =>
  app.report.queries.filter(
    ({ filter }) =>
      filter.kinds?.includes(9) &&
      filter.top_level === true &&
      filter["#h"]?.includes(channel) &&
      filter.until === undefined,
  );

test("cold opening bypasses held DM labels; warm switching paints without a head read", {
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
  app.relay.holdEose("alpha");
  app.relay.holdEose("beta");
  // Establish a cold target deterministically: let the actual label read own
  // the background slot before preferences release the roster warmer. Hold the
  // host decoder, not a reader slot; demand and all production owners stay real.
  const preferences = Promise.withResolvers();
  let preferencesPending = false;
  await page.route("**/sidebar-preferences", async (route) => {
    preferencesPending = true;
    await preferences.promise;
    await route.fallback();
  });
  // A visible pre-establishment head is not a warm, verified cache. A signed
  // missed message proves the catch-up reached the UI, not merely the broker.
  try {
    await open(page, app);
    expect(heads(app, "alpha")).toHaveLength(1);
    const missed = Object.fromEntries(
      ["alpha", "beta"].map((channel) => [
        channel,
        app.append("primary", channel, "Startup catch-up marker", false),
      ]),
    );
    // Alpha and Beta may share one wire and therefore one EOSE. Release both
    // holds; Alpha catches up, while the still-unopened Beta remains cold.
    app.relay.releaseEose("alpha");
    app.relay.releaseEose("beta");
    await expect(
      page.locator(`[data-message-id="${missed.alpha.id}"]`),
    ).toBeVisible();
    expect(heads(app, "alpha")).toHaveLength(2);
    await expect.poll(() => labelReads().length).toBe(1);
    expect(labelReads()[0].filter.authors).toHaveLength(500);
    expect(app.report.profileHolds.some((held) => held.pending)).toBe(true);
    await expect.poll(() => preferencesPending).toBe(true);
    const decoded = page.waitForResponse(
      (response) =>
        response.url().endsWith("/sidebar-preferences") && response.ok(),
    );
    preferences.resolve();
    await decoded;
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
    await expect(
      page.locator(`[data-message-id="${missed.beta.id}"]`),
    ).toBeVisible();
    expect(heads(app, "beta")).toHaveLength(1);
    const before = submittedHeads.length;
    const targetMs = 100;
    const warmTimings = [];
    // Attribution for a slow sample: long browser frames (with their scripts)
    // show app work; a stalled test process, which also serves the app and
    // broker, shows that the runner itself stopped. WebKit has no LoAF API.
    const longFramesSupported = await page.evaluate(() => {
      if (
        !PerformanceObserver.supportedEntryTypes.includes(
          "long-animation-frame",
        )
      )
        return false;
      window.__warmSwitchLongFrames = [];
      new PerformanceObserver((list) =>
        window.__warmSwitchLongFrames.push(...list.getEntries()),
      ).observe({ type: "long-animation-frame" });
      return true;
    });
    const loopDelay = monitorEventLoopDelay({ resolution: 10 });
    // Browser-clock click → first visible row → paint, excluding Playwright IPC.
    for (const name of ["Alpha", "Beta", "Alpha", "Beta"]) {
      loopDelay.reset();
      loopDelay.enable();
      const timing = await page
        .getByRole("button", { name, exact: true })
        .evaluate(
          async (button, { name, ids }) => {
            const start = performance.now();
            button.click();
            const clickDispatchMs = performance.now() - start;
            const frames = [];
            let firstVisibleMs;
            let paintOpportunity;
            await new Promise((resolve, reject) => {
              const deadline = setTimeout(
                () => reject(new Error("warm switch did not paint")),
                1000,
              );
              const check = (timestamp) => {
                frames.push({
                  frameMs: timestamp - start,
                  callbackMs: performance.now() - start,
                });
                const composer = document.querySelector(
                  `[role="textbox"][aria-label="Message #${name}"]`,
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
                firstVisibleMs = performance.now() - start;
                requestAnimationFrame((timestamp) => {
                  paintOpportunity = {
                    frameMs: timestamp - start,
                    callbackMs: performance.now() - start,
                  };
                  clearTimeout(deadline);
                  resolve();
                });
              };
              requestAnimationFrame(check);
            });
            const warmVisibleMs = performance.now() - start;
            return {
              startedAt: start,
              warmVisibleMs,
              // Synchronous button.click() only, not all React/render work.
              clickDispatchMs,
              frames,
              firstVisibleMs,
              paintOpportunity,
            };
          },
          {
            name,
            ids: app.histories
              .get(`primary/${name.toLowerCase()}`)
              .map((event) => event.id),
          },
        );
      loopDelay.disable();
      timing.testProcessMaxStallMs = Math.round(loopDelay.max / 1e6);
      // One shared record, so long-frame attribution reaches the evidence.
      const sample = { name, ...timing };
      app.report.measurements.push(sample);
      warmTimings.push(sample);
    }
    if (longFramesSupported) {
      // LoAF entries are queued after their frame ends; wait for the last one.
      const frames = await page.evaluate(
        () =>
          new Promise((resolve) =>
            requestAnimationFrame(() =>
              setTimeout(() =>
                resolve(
                  window.__warmSwitchLongFrames.map((frame) => ({
                    start: frame.startTime,
                    duration: frame.duration,
                    blockingMs: frame.blockingDuration,
                    scripts: frame.scripts.map((script) => ({
                      invoker: script.invoker,
                      source: `${script.sourceURL.split("/").at(-1)}:${script.sourceCharPosition}`,
                      durationMs: Math.round(script.duration),
                    })),
                  })),
                ),
              ),
            ),
          ),
      );
      for (const timing of warmTimings) {
        const end = timing.startedAt + timing.warmVisibleMs;
        timing.longFrames = frames
          .filter(
            ({ start, duration }) =>
              start < end && start + duration > timing.startedAt,
          )
          .map(({ start, duration, ...frame }) => ({
            startMs: Math.round(start - timing.startedAt),
            durationMs: Math.round(duration),
            ...frame,
          }));
      }
    }
    // Surface target misses, with their attribution, without failing the
    // test: shared-runner timing is evidence here, not a gate.
    for (const {
      name,
      warmVisibleMs,
      longFrames,
      testProcessMaxStallMs,
    } of warmTimings) {
      if (warmVisibleMs < targetMs) continue;
      const scriptMs = (longFrames ?? []).reduce(
        (total, frame) =>
          total +
          frame.scripts.reduce((sum, script) => sum + script.durationMs, 0),
        0,
      );
      const frames = longFrames
        ? `${longFrames.length} long frames, ${scriptMs} ms of script`
        : "long frames unavailable";
      test.info().annotations.push({
        type: "performance",
        description: `${name} warm switch: ${warmVisibleMs.toFixed(1)}ms (target <${targetMs}ms; ${frames}; test process stalled up to ${testProcessMaxStallMs} ms)`,
      });
    }
    expect(submittedHeads).toHaveLength(before);
    await openChannelDetails(page);
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
    preferences.resolve();
    app.relay.releaseEose("alpha");
    app.relay.releaseEose("beta");
    app.relay.releaseProfiles();
    await page.unrouteAll({ behavior: "wait" });
  }
});

test.describe("large thread opening", () => {
  test.use({
    readState: true,
    largeSidebar: false,
    threadUnread: true,
    presenceThreadAuthors: 300,
  });
  test("300-author thread opening retains bounded traversal and measures cold/reopened rendering", async ({
    page,
    app,
  }) => {
    await open(page, app);
    const { root } = app.presenceThread;
    const trigger = page
      .locator(`[data-channel-timeline] [data-message-id="${root.id}"]`)
      .getByRole("button", { name: /^View thread:/ });
    const history = page.getByRole("region", {
      name: "Thread messages",
      exact: true,
    });
    for (const phase of ["cold", "reopened"]) {
      const timing = await trigger.evaluate(async (button) => {
        const start = performance.now();
        button.click();
        let firstPaint;
        await new Promise((resolve, reject) => {
          const deadline = setTimeout(
            () => reject(new Error("thread did not finish traversal")),
            10000,
          );
          const check = () => {
            const panel = document.querySelector(
              '[aria-label="Thread messages"]',
            );
            const rows = panel?.querySelectorAll("[data-message-id]");
            const rect = panel?.getBoundingClientRect();
            const visible =
              rect &&
              [...rows].some((row) => {
                const bounds = row.getBoundingClientRect();
                return (
                  bounds.height > 0 &&
                  bounds.bottom > rect.top &&
                  bounds.top < rect.bottom
                );
              });
            if (visible && firstPaint === undefined)
              firstPaint = performance.now() - start;
            if (
              !visible ||
              rows.length !== 301 ||
              panel.textContent.includes("Loading thread…")
            )
              return requestAnimationFrame(check);
            requestAnimationFrame(() => {
              clearTimeout(deadline);
              resolve();
            });
          };
          requestAnimationFrame(check);
        });
        return {
          firstVisibleMs: firstPaint,
          fullTraversalPaintMs: performance.now() - start,
        };
      });
      app.report.measurements.push({
        scenario: "300-author-thread",
        phase,
        ...timing,
      });
      await expect(history.locator("[data-message-id]")).toHaveCount(301);
      await expect(
        history.getByText("Distinct author reply 299", { exact: true }),
      ).toBeInViewport();
      await page
        .getByRole("button", {
          name: /^Close (?:thread|Thread tab)$/,
          exact: true,
        })
        .click();
      await expect(history).toHaveCount(0);
    }
  });
});
